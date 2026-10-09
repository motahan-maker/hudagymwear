// Merchandising: category visibility, mirrored from the live storefront logic
// (shop tabs, NEW IN / BEST SELLERS badges, lookbook edits).
// Categories are the single source of truth — one category per product.
import { useSyncExternalStore, useMemo } from 'react';
import { categories as siteCategories, type Product } from './catalog';
import { getSupabase } from './supabase';
import { broadcastStoreEvent, subscribeToStoreEvent } from './realtime';

export type CategorySetting = { name: string; visible: boolean; order: number };

const CAT_KEY = 'huda.categories.v1';
const LEGACY_COL_KEY = 'huda.collections.v1';

export function clearLegacyCollections(): void {
  try { localStorage.removeItem(LEGACY_COL_KEY); } catch { /* ignore */ }
}

function seedCategories(): CategorySetting[] {
  return siteCategories.map((name, order) => ({ name, visible: true, order }));
}

function readCategories(): CategorySetting[] {
  try {
    const raw = localStorage.getItem(CAT_KEY);
    if (raw) {
      const list = JSON.parse(raw) as CategorySetting[];
      // Pick up any brand-new site categories added in code later.
      const known = new Set(list.map((c) => c.name));
      siteCategories.forEach((name) => {
        if (!known.has(name)) list.push({ name, visible: false, order: list.length });
      });
      return list;
    }
  } catch { /* ignore */ }
  const seeds = seedCategories();
  try { localStorage.setItem(CAT_KEY, JSON.stringify(seeds)); } catch { /* ignore */ }
  return seeds;
}

function writeCategories(list: CategorySetting[]) {
  try { localStorage.setItem(CAT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// In-memory reactive state
let memoryCategories: CategorySetting[] = readCategories().sort((a, b) => a.order - b.order);
const categoryListeners = new Set<() => void>();

export function subscribeCategories(listener: () => void): () => void {
  categoryListeners.add(listener);
  return () => {
    categoryListeners.delete(listener);
  };
}

function notifyCategoriesChanged() {
  categoryListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

export function listCategories(): CategorySetting[] {
  return memoryCategories;
}

export function setCategoriesFromSettings(raw: unknown): void {
  if (!raw) return;
  try {
    const list = typeof raw === 'string' ? (JSON.parse(raw) as CategorySetting[]) : (raw as CategorySetting[]);
    if (Array.isArray(list) && list.length > 0) {
      const known = new Set(list.map((c) => c.name));
      siteCategories.forEach((name) => {
        if (!known.has(name)) list.push({ name, visible: false, order: list.length });
      });
      const sorted = [...list].sort((a, b) => a.order - b.order);
      memoryCategories = sorted;
      writeCategories(sorted);
      notifyCategoriesChanged();
    }
  } catch {
    /* ignore */
  }
}

export async function hydrateCategories(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data, error } = await sb.from('shop_settings').select('categories').eq('id', 1).maybeSingle();
    if (error || !data) return;
    setCategoriesFromSettings(data.categories);
  } catch {
    /* ignore */
  }
}

export async function saveCategories(list: CategorySetting[]): Promise<void> {
  const sorted = [...list].sort((a, b) => a.order - b.order);
  memoryCategories = sorted;
  writeCategories(sorted);
  notifyCategoriesChanged();
  broadcastStoreEvent('categories:changed', { categories: sorted });

  const sb = getSupabase();
  if (!sb) return;
  try {
    await sb.from('shop_settings').update({ categories: sorted }).eq('id', 1);
  } catch {
    /* ignore — RLS enforces admin */
  }
}

export function visibleCategoryNames(): string[] {
  return listCategories().filter((c) => c.visible).map((c) => c.name);
}

// React hooks
export function useCategories(): CategorySetting[] {
  return useSyncExternalStore(
    subscribeCategories,
    listCategories,
    listCategories
  );
}

export function useVisibleCategories(): string[] {
  const cats = useCategories();
  return useMemo(() => cats.filter((c) => c.visible).map((c) => c.name), [cats]);
}

export type FormCard = { name: string; image: string; productId: string };
export function formCards(all: Product[], n = 3): FormCard[] {
  const out: FormCard[] = [];
  for (const name of visibleCategoryNames()) {
    const first = all.find((p) => p.category === name && (p.status ?? 'Active') === 'Active');
    if (first) out.push({ name, image: first.images?.[0] ?? first.image, productId: first.id });
    if (out.length >= n) break;
  }
  return out;
}

export function homepageFavourites(all: Product[], n = 4): Product[] {
  const live = all.filter((p) => (p.status ?? 'Active') === 'Active');
  const fresh = live.filter((p) => p.badge === 'NEW');
  const proven = live.filter((p) => p.badge === 'BESTSELLER');
  const seen = new Set<string>();
  const picks = [...fresh, ...proven].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return (picks.length ? picks : live).slice(0, n);
}

export type NavLink = { label: string; handle: string };
export function sidebarNav(): NavLink[] {
  return [
    { label: 'New In', handle: 'new' },
    ...visibleCategoryNames().map((name) => ({ label: name, handle: name })),
  ];
}

export function headerNav(): NavLink[] {
  const cats = visibleCategoryNames();
  const links: NavLink[] = [{ label: 'New In', handle: 'new' }, { label: 'Clothing', handle: 'all' }];
  if (cats.includes('Hoodies')) links.push({ label: 'Hoodies', handle: 'Hoodies' });
  if (cats.includes('Matching Sets')) links.push({ label: 'Sets', handle: 'Matching Sets' });
  links.push({ label: 'Best Sellers', handle: 'best' });
  return links;
}

export function useHeaderNav(): NavLink[] {
  const cats = useVisibleCategories();
  return useMemo(() => {
    const links: NavLink[] = [{ label: 'New In', handle: 'new' }, { label: 'Clothing', handle: 'all' }];
    if (cats.includes('Hoodies')) links.push({ label: 'Hoodies', handle: 'Hoodies' });
    if (cats.includes('Matching Sets')) links.push({ label: 'Sets', handle: 'Matching Sets' });
    links.push({ label: 'Best Sellers', handle: 'best' });
    return links;
  }, [cats]);
}

export function useSidebarNav(): NavLink[] {
  const cats = useVisibleCategories();
  return useMemo(() => [
    { label: 'New In', handle: 'new' },
    ...cats.map((name) => ({ label: name, handle: name })),
  ], [cats]);
}

// Hook into realtime events automatically
if (typeof window !== 'undefined') {
  subscribeToStoreEvent('categories:changed', () => {
    void hydrateCategories();
  });
}
