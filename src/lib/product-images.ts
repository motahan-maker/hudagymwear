// Product image uploads to Supabase Storage (public bucket `product-images`).
// Every upload is resized (max 1200px) and converted to WebP quality 75% in
// the browser BEFORE leaving the device — so storage stays small and every
// product image is a fast .webp with zero server work and zero paid transforms.
import { getSupabase, isSupabaseConfigured } from './supabase';

export const PRODUCT_BUCKET = 'product-images';
/** Private bucket holding customer bank-transfer receipts (signed URLs only). */
export const TRANSFER_BUCKET = 'transfer-proofs';
// Shopify-style output: max 1200px (covers retina for 768px displays),
// WebP quality 75% — a 3-5MB phone photo lands around 60-120KB (~95% smaller).
const MAX_DIM = 1200;
const WEBP_QUALITY = 0.75;
const MAX_FILE_MB = 10;

export const isStorageReady = isSupabaseConfigured;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read this image file.'));
    img.src = src;
  });
}

/** Resize + convert any image file to WebP. Returns the blob, size ratio and final KB. */
export async function toWebP(file: File): Promise<{ blob: Blob; ratio: number; kb: number }> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file (JPG, PNG or WebP).');
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`Images must be under ${MAX_FILE_MB}MB.`);
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot process images.');
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY));
    if (!blob) throw new Error('WebP conversion failed in this browser.');
    return { blob, ratio: blob.size / file.size, kb: Math.max(1, Math.round(blob.size / 1024)) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Demo-mode upload (no Supabase): WebP as a data URL stored with the product
 *  in this browser. Same 1200px / 75% pipeline — sync everywhere once Storage
 *  is connected (re-upload then). */
export async function fileToWebPDataUrl(file: File): Promise<{ url: string; savedPct: number; kb: number }> {
  const { blob, ratio, kb } = await toWebP(file);
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read this image file.'));
    reader.readAsDataURL(blob);
  });
  return { url, savedPct: Math.max(0, Math.round((1 - ratio) * 100)), kb };
}

function uniqueName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${rand}.webp`;
}

/** Upload a file as WebP and return its public URL. Throws with a friendly message. */
export async function uploadProductImage(file: File): Promise<{ url: string; savedPct: number; kb: number }> {
  const sb = getSupabase();
  if (!sb) throw new Error('Connect Supabase Storage first (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY).');
  const { blob, ratio, kb } = await toWebP(file);
  const path = uniqueName();
  const { error } = await sb.storage.from(PRODUCT_BUCKET).upload(path, blob, {
    contentType: 'image/webp',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) {
    if (/bucket|not found/i.test(error.message)) {
      throw new Error(`Storage bucket "${PRODUCT_BUCKET}" is missing — run supabase/migrations/0002_storage.sql first.`);
    }
    if (/row-level|policy|permission|unauthorized/i.test(error.message)) {
      throw new Error('Upload blocked by storage permissions — sign in with an admin account.');
    }
    throw new Error(error.message);
  }
  const { data } = sb.storage.from(PRODUCT_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, savedPct: Math.max(0, Math.round((1 - ratio) * 100)), kb };
}

/** Best-effort delete of a previously uploaded storage image. Never throws. */
export async function deleteProductImage(url: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const marker = `/${PRODUCT_BUCKET}/`;
  const at = url.indexOf(marker);
  if (at === -1) return; // gallery seed, external URL, or other bucket — leave it.
  const path = url.slice(at + marker.length).split('?')[0];
  if (!path) return;
  try {
    await sb.storage.from(PRODUCT_BUCKET).remove([path]);
  } catch { /* orphan file at worst — never block the editor */ }
}

/** Upload a bank-transfer receipt as WebP to the private `transfer-proofs`
 *  bucket at `<orderId>/<unique>.webp` and return the storage path.
 *  Demo mode (no Supabase): falls back to a browser-local WebP data URL. */
export async function uploadTransferProof(orderId: string, file: File): Promise<{ path: string; kb: number }> {
  const sb = getSupabase();
  if (!sb) {
    const { url, kb } = await fileToWebPDataUrl(file);
    return { path: url, kb };
  }
  const { blob, kb } = await toWebP(file);
  const safeId = orderId.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'order';
  const path = `${safeId}/${uniqueName()}`;
  const { error } = await sb.storage.from(TRANSFER_BUCKET).upload(path, blob, {
    contentType: 'image/webp',
    cacheControl: '3600',
    upsert: false,
  });
  if (error) {
    if (/bucket|not found/i.test(error.message)) {
      throw new Error(`Storage bucket "${TRANSFER_BUCKET}" is missing — run the storage migration first.`);
    }
    if (/row-level|policy|permission|unauthorized/i.test(error.message)) {
      throw new Error('Upload blocked by storage permissions — please try again.');
    }
    throw new Error(error.message);
  }
  return { path, kb };
}
