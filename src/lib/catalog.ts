import { useSyncExternalStore, useMemo } from 'react';
import black from '@/assets/black-set.jpg';
import taupe from '@/assets/taupe-set.jpg';
import grey from '@/assets/grey-set.jpg';
import burgundy from '@/assets/burgundy-hoodie.jpg';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { broadcastStoreEvent, subscribeToStoreEvent } from './realtime';

// ---------------------------------------------------------------------------
// Catalogue model (Supabase-ready)
// ---------------------------------------------------------------------------
export type ProductColour = { name: string; tone: string; images: string[]; hex?: string };
export type StockMap = Partial<Record<string, number>>;
export type ProductStatus = 'Active' | 'Draft';
export type Product = {
  id: string;
  name: string;
  category: string;
  colour: string;
  tone: string;
  price: number;
  image: string;
  images?: string[];
  colours?: ProductColour[];
  badge?: string;
  crop?: string;
  description?: string;
  salePrice?: number;
  stock?: number;
  stockBySize?: StockMap;
  status?: ProductStatus;
  sku?: string;
};

const seed: Product[] = [
 {id:'sculpt-seamless-leggings',name:'Sculpt Seamless Leggings',category:'Leggings',colour:'Onyx Black',tone:'onyx',price:48,image:black,badge:'BESTSELLER',crop:'leggings',status:'Active'},
 {id:'sculpt-seamless-bra',name:'Sculpt Seamless Sports Bra',category:'Sports Bras',colour:'Onyx Black',tone:'onyx',price:32,image:black,badge:'BESTSELLER',crop:'bra',status:'Active'},
 {id:'form-seamless-leggings',name:'Form Seamless Leggings',category:'Leggings',colour:'Soft Taupe',tone:'taupe',price:48,image:taupe,badge:'NEW',crop:'leggings',status:'Active'},
 {id:'elevate-long-sleeve',name:'Elevate Long Sleeve Crop',category:'Tops',colour:'Charcoal',tone:'charcoal',price:38,image:grey,badge:'NEW',crop:'bra',status:'Active'},
 {id:'form-seamless-bra',name:'Form Seamless Sports Bra',category:'Sports Bras',colour:'Soft Taupe',tone:'taupe',price:32,image:taupe,crop:'bra',status:'Active'},
 {id:'sculpt-matching-set',name:'The Sculpt Matching Set',category:'Matching Sets',colour:'Onyx Black',tone:'onyx',price:80,image:black,status:'Active'},
 {id:'form-matching-set',name:'The Form Matching Set',category:'Matching Sets',colour:'Soft Taupe',tone:'taupe',price:80,image:taupe,status:'Active'},
 {id:'huda-sculpt-zip-hoodie',name:'Huda Sculpt Zip Hoodie',category:'Hoodies',colour:'Burgundy',tone:'burgundy',price:65,image:burgundy,badge:'NEW',crop:'bra',status:'Active'},
 {id:'huda-core-flare-pants',name:'Huda Core Flare Pants',category:'Bottoms',colour:'Burgundy',tone:'burgundy',price:55,salePrice:45,image:burgundy,badge:'SALE',crop:'leggings',status:'Active'},
 {id:'elevate-leggings',name:'Elevate Seamless Leggings',category:'Leggings',colour:'Charcoal',tone:'charcoal',price:48,image:grey,crop:'leggings',status:'Active'},
];

export const sizes = ['XS','S','M','L','XL'];
export const tones = ['onyx','taupe','charcoal','burgundy'];
export const toneFamilies = [
  { id: 'onyx', label: 'Black' },
  { id: 'white', label: 'White' },
  { id: 'charcoal', label: 'Grey' },
  { id: 'taupe', label: 'Nude & Brown' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' },
  { id: 'burgundy', label: 'Burgundy & Red' },
];

export type ColourPreset = { name: string; tone: string; hex: string };
export const COLOUR_PRESETS: ColourPreset[] = [
  { name: 'Onyx Black', tone: 'onyx', hex: '#1c1a18' },
  { name: 'Jet Black', tone: 'onyx', hex: '#0b0b0c' },
  { name: 'Washed Black', tone: 'onyx', hex: '#35322f' },
  { name: 'White', tone: 'white', hex: '#f7f5f0' },
  { name: 'Off-White', tone: 'white', hex: '#efe9dd' },
  { name: 'Cream', tone: 'white', hex: '#e8dcc3' },
  { name: 'Charcoal', tone: 'charcoal', hex: '#4a4d52' },
  { name: 'Slate Grey', tone: 'charcoal', hex: '#6b7280' },
  { name: 'Heather Grey', tone: 'charcoal', hex: '#a7adb5' },
  { name: 'Soft Taupe', tone: 'taupe', hex: '#b9a48e' },
  { name: 'Sand', tone: 'taupe', hex: '#d6c6a8' },
  { name: 'Camel', tone: 'taupe', hex: '#b98a52' },
  { name: 'Mocha', tone: 'taupe', hex: '#6f5844' },
  { name: 'Chocolate', tone: 'taupe', hex: '#3e2c22' },
  { name: 'Forest Green', tone: 'green', hex: '#24473a' },
  { name: 'Sage', tone: 'green', hex: '#9caf88' },
  { name: 'Olive', tone: 'green', hex: '#6b6b3a' },
  { name: 'Emerald', tone: 'green', hex: '#0f6f5c' },
  { name: 'Navy', tone: 'blue', hex: '#1f2a44' },
  { name: 'Sky Blue', tone: 'blue', hex: '#a9c8e8' },
  { name: 'Teal', tone: 'blue', hex: '#14707a' },
  { name: 'Plum', tone: 'purple', hex: '#5b2a4a' },
  { name: 'Lavender', tone: 'purple', hex: '#c3b2dc' },
  { name: 'Mauve', tone: 'purple', hex: '#9b7b8e' },
  { name: 'Blush Pink', tone: 'pink', hex: '#e8b4b8' },
  { name: 'Hot Pink', tone: 'pink', hex: '#e0447c' },
  { name: 'Burgundy', tone: 'burgundy', hex: '#6d1f2c' },
  { name: 'Rust', tone: 'burgundy', hex: '#a34a28' },
  { name: 'Deep Red', tone: 'burgundy', hex: '#b3261e' },
];
export function presetFor(name: string): ColourPreset | undefined {
  return COLOUR_PRESETS.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
}
export function guessTone(name: string): string {
  const n = name.toLowerCase();
  const hit = COLOUR_PRESETS.find((c) => n.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(n));
  if (hit) return hit.tone;
  if (/black|noir|onyx|jet|carbon|ink/.test(n)) return 'onyx';
  if (/white|ivory|cream|pearl|chalk|milk/.test(n)) return 'white';
  if (/grey|gray|charcoal|slate|ash|silver|smoke|stone/.test(n)) return 'charcoal';
  if (/taupe|beige|sand|camel|nude|mocha|coffee|brown|choco|tan|khaki|clay|oat/.test(n)) return 'taupe';
  if (/green|sage|olive|forest|emerald|mint|khaki/.test(n)) return 'green';
  if (/navy|blue|sky|teal|aqua|denim|cobalt|ocean/.test(n)) return 'blue';
  if (/purple|plum|lavender|violet|mauve|lilac|grape/.test(n)) return 'purple';
  if (/pink|blush|rose|fuchsia|magenta|coral/.test(n)) return 'pink';
  if (/burgundy|wine|maroon|rust|red|crimson|cherry|brick/.test(n)) return 'burgundy';
  return 'onyx';
}
export const categories = ['Leggings','Sports Bras','Tops','Hoodies','Bottoms','Matching Sets','Accessories'];
export const badges = ['NEW','BESTSELLER','SALE'];

export const galleryImages = [
  { id: 'black', src: black, label: 'Onyx set' },
  { id: 'taupe', src: taupe, label: 'Taupe set' },
  { id: 'grey', src: grey, label: 'Charcoal set' },
  { id: 'burgundy', src: burgundy, label: 'Burgundy hoodie' },
];

export const money = (n:number) => new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(n);
export function effectivePrice(p: { price: number; salePrice?: number }): number {
  return p.salePrice ?? p.price;
}
export const SITE_URL=(import.meta.env['VITE_SITE_URL'] as string | undefined)?.replace(/\/$/,'')||'';
export function pageHead(title:string,description:string,extra?:{path?:string;image?:string}){const full=`${title} | HUDA GYMWEAR`;const rawImg=extra?.image??'/favicon.png';const image=!rawImg?'':rawImg.startsWith('http')?rawImg:SITE_URL?`${SITE_URL}${rawImg}`:'';const url=SITE_URL&&extra?.path?`${SITE_URL}${extra.path}`:'';return {meta:[{title:full},{name:'description',content:description},...(url?[{rel:'canonical',href:url}]:[]),{property:'og:title',content:full},{property:'og:description',content:description},{property:'og:type',content:'website'},...(url?[{property:'og:url',content:url}]:[]),...(image?[{property:'og:image',content:image}]:[]),{name:'twitter:card',content:'summary_large_image'},{name:'twitter:title',content:full},{name:'twitter:description',content:description},...(image?[{name:'twitter:image',content:image}]:[]),]};}

// --- stock helpers ----------------------------------------------------------
export const DEFAULT_STOCK = 25;
export function sizeStock(p: Product, size: string): number {
  return p.stockBySize?.[size] ?? p.stock ?? DEFAULT_STOCK;
}
export function totalStock(p: Product): number {
  if (p.stockBySize) return sizes.reduce((n, s) => n + (p.stockBySize?.[s] ?? 0), 0);
  return p.stock ?? DEFAULT_STOCK;
}
export function isSoldOut(p: Product): boolean {
  return (p.status ?? 'Active') !== 'Active' || totalStock(p) <= 0;
}

export function productImage(p: Product, colourName?: string): string {
  if (colourName && p.colours) {
    const c = p.colours.find((c) => c.name === colourName);
    if (c?.images?.[0]) return c.images[0];
  }
  return p.images?.[0] ?? p.image;
}
export function productColours(p: Product): ProductColour[] {
  if (p.colours?.length) return p.colours;
  const preset = presetFor(p.colour);
  return [{ name: p.colour, tone: p.tone, images: [p.image], ...(preset ? { hex: preset.hex } : {}) }];
}

// --- storage-backed live catalogue ------------------------------------------
type CatalogueStore = { added: Product[]; overrides: Record<string, Partial<Product>>; removed: string[] };
const KEY = 'huda.catalog.v1';
const SYNCED_KEY = 'huda.catalog.synced.v1';

function readStore(): CatalogueStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as CatalogueStore;
      return { added: s.added ?? [], overrides: s.overrides ?? {}, removed: s.removed ?? [] };
    }
  } catch { /* ignore */ }
  return { added: [], overrides: {}, removed: [] };
}

function defaultMatrix(from?: number): StockMap {
  const v = from ?? DEFAULT_STOCK;
  return Object.fromEntries(sizes.map((s) => [s, v]));
}

function buildCatalogue(): Product[] {
  if (typeof localStorage === 'undefined') return seed.map((p) => ({ ...p, ...seedExtra(p.id) }));
  
  // 1. Check if we already have an authoritative synced catalog in localStorage
  try {
    const syncedRaw = localStorage.getItem(SYNCED_KEY);
    if (syncedRaw) {
      const parsed = JSON.parse(syncedRaw) as Product[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* ignore */ }

  const s = readStore();
  const out = seed
    .filter((p) => !s.removed.includes(p.id))
    .map((p) => {
      const merged = { ...p, ...seedExtra(p.id), ...(s.overrides[p.id] ?? {}) };
      if (!merged.stockBySize) merged.stockBySize = defaultMatrix(merged.stock);
      return merged;
    });
  for (const a of s.added) {
    if (!out.some((p) => p.id === a.id)) out.push({ ...a });
  }
  return out;
}

function persist(s: CatalogueStore) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function persistSynced(list: Product[]) {
  try { localStorage.setItem(SYNCED_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// Live mutable array for instant synchronous access
export const products: Product[] = buildCatalogue();

// Reactive listeners
let productListeners: Set<() => void> = new Set();
let productVersion = 0;

export function subscribeProducts(listener: () => void): () => void {
  productListeners.add(listener);
  return () => {
    productListeners.delete(listener);
  };
}

function notifyProductsChanged() {
  productVersion++;
  productListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

// Hook for React components to get reactive updates
export function useProducts(): Product[] {
  return useSyncExternalStore(
    subscribeProducts,
    () => products,
    () => products
  );
}

export function useActiveProducts(): Product[] {
  const all = useProducts();
  return useMemo(() => all.filter((p) => (p.status ?? 'Active') === 'Active'), [all]);
}

export function useProduct(id: string): Product | undefined {
  const all = useProducts();
  return useMemo(() => all.find((p) => p.id === id), [all, id]);
}

function seedExtra(id: string): Partial<Product> {
  const C = (name: string, tone: string, hex: string, images: string[]): ProductColour => ({ name, tone, hex, images });
  const map: Record<string, Partial<Product>> = {
    'sculpt-seamless-leggings': { description: 'Our signature second-skin legging. Sculpting compression, buttery hand-feel and a high rise that stays put from warm-up to wind-down.', colours: [C('Onyx Black', 'onyx', '#1c1a18', [black]), C('Soft Taupe', 'taupe', '#b9a48e', [taupe]), C('Charcoal', 'charcoal', '#4a4d52', [grey])] },
    'sculpt-seamless-bra': { description: 'Medium-support seamless bra with a sculpting band and second-skin fit. Made to match the Sculpt legging.', colours: [C('Onyx Black', 'onyx', '#1c1a18', [black]), C('Soft Taupe', 'taupe', '#b9a48e', [taupe])] },
    'form-seamless-leggings': { description: 'Everyday-soft seamless legging in a warm taupe tone. Gentle compression with an all-day comfort waistband.', colours: [C('Soft Taupe', 'taupe', '#b9a48e', [taupe]), C('Onyx Black', 'onyx', '#1c1a18', [black]), C('Charcoal', 'charcoal', '#4a4d52', [grey])] },
    'elevate-long-sleeve': { description: 'Long-sleeve crop with thumbholes and a second-skin finish. Layers beautifully over any sports bra.', colours: [C('Charcoal', 'charcoal', '#4a4d52', [grey]), C('Onyx Black', 'onyx', '#1c1a18', [black])] },
    'form-seamless-bra': { description: 'Light, breathable seamless bra in soft taupe. Everyday comfort with a flattering scoop neckline.', colours: [C('Soft Taupe', 'taupe', '#b9a48e', [taupe]), C('Onyx Black', 'onyx', '#1c1a18', [black])] },
    'sculpt-matching-set': { description: 'The full Sculpt look — seamless legging plus matching bra in onyx black. One decision, endless outfits.', colours: [C('Onyx Black', 'onyx', '#1c1a18', [black]), C('Soft Taupe', 'taupe', '#b9a48e', [taupe])] },
    'form-matching-set': { description: 'The full Form look in soft taupe — seamless legging plus bra. Effortless coordination, all-day softness.', colours: [C('Soft Taupe', 'taupe', '#b9a48e', [taupe]), C('Onyx Black', 'onyx', '#1c1a18', [black])] },
    'huda-sculpt-zip-hoodie': { description: 'Sculpting zip hoodie in signature burgundy. Structured shoulders, cropped body, brushed-back warmth.', colours: [C('Burgundy', 'burgundy', '#6d1f2c', [burgundy]), C('Onyx Black', 'onyx', '#1c1a18', [black])] },
    'huda-core-flare-pants': { description: 'High-rise flare pants with a lengthening silhouette. Studio to street in signature burgundy.', colours: [C('Burgundy', 'burgundy', '#6d1f2c', [burgundy]), C('Onyx Black', 'onyx', '#1c1a18', [black])] },
    'elevate-leggings': { description: 'Seamless Elevate legging in charcoal. Breathable knit with sculpting contour lines.', colours: [C('Charcoal', 'charcoal', '#4a4d52', [grey]), C('Onyx Black', 'onyx', '#1c1a18', [black]), C('Soft Taupe', 'taupe', '#b9a48e', [taupe])] },
  };
  return map[id] ?? {};
}

export function getProduct(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}

export function activeProducts(): Product[] {
  return products.filter((p) => (p.status ?? 'Active') === 'Active');
}

// --- Supabase row <-> Product mappers ----------------------------------------
export type ProductRow = {
  id: string;
  name: string;
  category: string;
  colour: string;
  tone: string;
  price: number;
  sale_price: number | null;
  badge: string | null;
  status: string | null;
  description: string | null;
  image: string;
  images: string[] | null;
  colours: ProductColour[] | null;
  stock_by_size: StockMap | null;
  sku: string | null;
  crop: string | null;
  created_at?: string;
  updated_at?: string;
};

export function toProduct(r: ProductRow): Product {
  const p: Product = {
    id: r.id,
    name: r.name,
    category: r.category,
    colour: r.colour,
    tone: r.tone,
    price: Number(r.price),
    image: r.image,
  };
  if (Array.isArray(r.images)) p.images = [...r.images];
  if (Array.isArray(r.colours)) p.colours = r.colours.map((c) => ({ ...c, images: [...(c.images ?? [])] }));
  if (r.sale_price != null) p.salePrice = Number(r.sale_price);
  if (r.badge != null) p.badge = r.badge;
  if (r.status != null) p.status = r.status as ProductStatus;
  if (r.description != null) p.description = r.description;
  if (r.sku != null) p.sku = r.sku;
  if (r.crop != null) p.crop = r.crop;
  if (r.stock_by_size != null && typeof r.stock_by_size === 'object') p.stockBySize = { ...(r.stock_by_size as StockMap) };
  return p;
}

export function toRow(p: Product): ProductRow {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    colour: p.colour,
    tone: p.tone,
    price: p.price,
    sale_price: p.salePrice ?? null,
    badge: p.badge ?? null,
    status: p.status ?? 'Active',
    description: p.description ?? null,
    image: p.image,
    images: p.images ?? (p.image ? [p.image] : []),
    colours: p.colours ?? [],
    stock_by_size: p.stockBySize ?? {},
    sku: p.sku ?? null,
    crop: p.crop ?? null,
  };
}

export async function hydrateCatalog(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data, error } = await sb.from('products').select('*');
    if (error || !data) return;
    const rows = data as unknown as ProductRow[];
    
    // Convert to products
    const mapped = rows.map(toProduct);
    
    // Authoritative update
    products.splice(0, products.length, ...mapped);
    persistSynced(mapped);
    notifyProductsChanged();
  } catch { /* ignore */ }
}

export async function upsertProduct(p: Product): Promise<void> {
  const i = products.findIndex((x) => x.id === p.id);
  const s = readStore();
  if (i >= 0) {
    products[i] = { ...p };
    const base = seed.find((x) => x.id === p.id);
    s.overrides[p.id] = base ? diff(base, p) : {};
    s.added = s.added.map((a) => (a.id === p.id ? { ...p } : a));
    if (!base && !s.added.some((a) => a.id === p.id)) s.added.push({ ...p });
  } else {
    products.push({ ...p });
    s.added = [...s.added.filter((a) => a.id !== p.id), { ...p }];
  }
  s.removed = s.removed.filter((id) => id !== p.id);
  persist(s);
  persistSynced(products);
  notifyProductsChanged();
  broadcastStoreEvent('products:changed', { action: 'upsert', id: p.id });

  const sb = getSupabase();
  if (!sb) return;
  try {
    await sb.from('products').upsert(toRow(p), { onConflict: 'id' });
  } catch { /* ignore */ }
}

export async function deleteProduct(id: string): Promise<void> {
  const i = products.findIndex((x) => x.id === id);
  if (i >= 0) products.splice(i, 1);
  const s = readStore();
  s.added = s.added.filter((a) => a.id !== id);
  delete s.overrides[id];
  if (!s.removed.includes(id)) s.removed.push(id);
  persist(s);
  persistSynced(products);
  notifyProductsChanged();
  broadcastStoreEvent('products:changed', { action: 'delete', id });

  const sb = getSupabase();
  if (!sb) return;
  try {
    await sb.from('products').delete().eq('id', id);
  } catch { /* ignore */ }
}

function diff(base: Product, next: Product): Partial<Product> {
  const out: Partial<Product> = {};
  (Object.keys(next) as (keyof Product)[]).forEach((k) => {
    if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) (out as Record<string, unknown>)[k as string] = next[k];
  });
  return out;
}

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || `piece-${Date.now()}`;
}

// Hook into realtime events automatically
if (typeof window !== 'undefined') {
  subscribeToStoreEvent('products:changed', () => {
    void hydrateCatalog();
  });
}
