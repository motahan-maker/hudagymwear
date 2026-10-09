import { getSupabase } from './supabase';
import { ordersByEmail } from './orders';
import { broadcastStoreEvent } from './realtime';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type Review = {
  id: string;
  productId: string;
  /** Supabase auth user id when signed-in. */
  userId?: string;
  author: string;
  email: string;
  rating: number; // 1-5
  title: string;
  body: string;
  size: string;
  verified: boolean;
  status: ReviewStatus;
  adminReply?: string;
  helpful: number;
  seed?: boolean;
  createdAt: string;
};

const KEY = 'huda.reviews.v1';
const VOTED_KEY = 'huda.reviews.voted.v1';

type ReviewRow = {
  id: string; product_id: string; user_id: string | null; author: string; email: string;
  rating: number; title: string; body: string; size: string; verified: boolean;
  status: string; admin_reply: string | null; helpful: number; seed: boolean; created_at: string;
};
const toReview = (r: ReviewRow): Review => ({
  id: r.id, productId: r.product_id,
  ...(r.user_id ? { userId: r.user_id } : {}),
  author: r.author, email: r.email, rating: r.rating, title: r.title, body: r.body,
  size: r.size, verified: r.verified, status: r.status as Review['status'],
  ...(r.admin_reply ? { adminReply: r.admin_reply } : {}),
  helpful: r.helpful, ...(r.seed ? { seed: true } : {}), createdAt: r.created_at,
});
function readAllSync(): Review[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Review[];
  } catch { /* ignore */ }
  return [];
}
function writeAll(list: Review[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
export async function approvedFor(productId: string): Promise<Review[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('reviews').select('*')
      .eq('product_id', productId).eq('status', 'approved').order('created_at', { ascending: false });
    if (error) return [];
    return ((data ?? []) as ReviewRow[]).map(toReview);
  }
  return readAllSync()
    .filter((r) => r.productId === productId && r.status === 'approved')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function pendingReviews(): Promise<Review[]> {
  const all = await allReviews();
  return all.filter((r) => r.status === 'pending');
}
export async function allReviews(): Promise<Review[]> {
  const sb = getSupabase();
  if (!sb) return readAllSync().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { data, error } = await sb.from('reviews').select('*').order('created_at', { ascending: false });
  if (error) return [];
  return ((data ?? []) as ReviewRow[]).map(toReview);
}
export async function averageRating(productId: string): Promise<{ avg: number; count: number; dist: number[] }> {
  const list = await approvedFor(productId);
  const dist = [0, 0, 0, 0, 0];
  for (const r of list) { const i = Math.min(5, Math.max(1, Math.round(r.rating))) - 1; dist[i] = (dist[i] ?? 0) + 1; }
  const avg = list.length ? list.reduce((n, r) => n + r.rating, 0) / list.length : 0;
  return { avg: Math.round(avg * 10) / 10, count: list.length, dist };
}
export async function hasReviewed(productId: string, email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const sb = getSupabase();
  if (!sb) return readAllSync().some((r) => r.productId === productId && r.email === e && r.status !== 'rejected');
  const { data: { session } } = await sb.auth.getSession();
  let q = sb.from('reviews').select('id').eq('product_id', productId).neq('status', 'rejected');
  q = session ? q.or(`user_id.eq.${session.user.id},email.eq.${e}`) : q.eq('email', e);
  const { data } = await q.limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}
export async function addReview(input: Omit<Review, 'id' | 'helpful' | 'status' | 'createdAt' | 'userId'> & { userId?: string }): Promise<Review> {
  const sb = getSupabase();
  if (!sb) {
    const review: Review = {
      ...input,
      email: input.email.trim().toLowerCase(),
      id: `rev-${Date.now().toString(36)}`,
      helpful: 0,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    writeAll([review, ...readAllSync()]);
    return review;
  }
  const id = `rev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const { data, error } = await sb.from('reviews').insert({
    id, product_id: input.productId, user_id: input.userId ?? null,
    author: input.author, email: input.email.trim().toLowerCase(),
    rating: input.rating, title: input.title, body: input.body, size: input.size,
    verified: input.verified, status: 'pending', helpful: 0, seed: false,
  }).select('*').single();
  if (error || !data) throw new Error(error?.message || 'Could not submit your review.');
  const rev = toReview(data as ReviewRow);
  broadcastStoreEvent('reviews:changed', { action: 'add', id: rev.id, productId: input.productId });
  return rev;
}
export async function setReviewStatus(id: string, status: ReviewStatus): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    writeAll(readAllSync().map((r) => (r.id === id ? { ...r, status } : r)));
    broadcastStoreEvent('reviews:changed', { action: 'status', id });
    return;
  }
  await sb.from('reviews').update({ status }).eq('id', id);
  broadcastStoreEvent('reviews:changed', { action: 'status', id });
}
export async function replyReview(id: string, reply: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    writeAll(readAllSync().map((r) => {
      if (r.id !== id) return r;
      if (!reply.trim()) {
        const { adminReply: _omit, ...rest } = r;
        void _omit;
        return rest;
      }
      return { ...r, adminReply: reply.trim() };
    }));
    broadcastStoreEvent('reviews:changed', { action: 'reply', id });
    return;
  }
  await sb.from('reviews').update({ admin_reply: reply.trim() || null }).eq('id', id);
  broadcastStoreEvent('reviews:changed', { action: 'reply', id });
}
export async function deleteReview(id: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    writeAll(readAllSync().filter((r) => r.id !== id));
    broadcastStoreEvent('reviews:changed', { action: 'delete', id });
    return;
  }
  await sb.from('reviews').delete().eq('id', id);
  broadcastStoreEvent('reviews:changed', { action: 'delete', id });
}
function readVoted(): string[] {
  try {
    const raw = localStorage.getItem(VOTED_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* ignore */ }
  return [];
}
export function hasVoted(id: string): boolean {
  return readVoted().includes(id);
}
export async function markHelpful(id: string): Promise<boolean> {
  if (hasVoted(id)) return false;
  const sb = getSupabase();
  if (sb) {
    // Server-side +1 via definer RPC (no client update rights on reviews).
    // Best-effort: the local vote still counts for this browser if it fails.
    try { await sb.rpc('vote_helpful', { rid: id }); } catch { /* ignore */ }
  } else {
    writeAll(readAllSync().map((r) => (r.id === id ? { ...r, helpful: r.helpful + 1 } : r)));
  }
  try { localStorage.setItem(VOTED_KEY, JSON.stringify([...readVoted(), id])); } catch { /* ignore */ }
  return true;
}

// Can this account review this product? Verified = account + delivered order with it.
export async function reviewEligibility(productId: string, email: string | null): Promise<{ ok: boolean; reason: string }> {
  if (!email) return { ok: false, reason: 'Sign in to write a review.' };
  if (await hasReviewed(productId, email)) return { ok: false, reason: 'You have already reviewed this piece — thank you!' };
  const bought = (await ordersByEmail(email)).some(
    (o) => o.status === 'Delivered' && o.items.some((it) => it.productId === productId),
  );
  if (!bought) return { ok: false, reason: 'Only verified buyers can review — purchase this piece first and it will unlock after delivery.' };
  return { ok: true, reason: '' };
}
