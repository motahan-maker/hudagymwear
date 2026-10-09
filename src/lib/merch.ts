// Merchandising: category visibility, mirrored from the live storefront logic
// (shop tabs, NEW IN / BEST SELLERS badges, lookbook edits).
// Categories are the single source of truth — one category per product.
import { categories as siteCategories, type Product } from './catalog';

export type CategorySetting = { name: string; visible: boolean; order: number };

const CAT_KEY = 'huda.categories.v1';
// Retired collections store (pre-categories era) — cleared once so old browsers
// don't carry dead merchandising data.
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
export function listCategories(): CategorySetting[] {
  return readCategories().sort((a, b) => a.order - b.order);
}
export function saveCategories(list: CategorySetting[]) {
  writeCategories(list);
}
export function visibleCategoryNames(): string[] {
  return listCategories().filter((c) => c.visible).map((c) => c.name);
}
// "Find your form" cards: first 3 visible categories that actually have
// live products, each represented by its first active product's image.
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
// Homepage "favourites": admin-flagged pieces — NEW first, then
// BESTSELLER, no duplicates. Falls back to the catalogue, never empty.
export function homepageFavourites(all: Product[], n = 4): Product[] {
  const live = all.filter((p) => (p.status ?? 'Active') === 'Active');
  const fresh = live.filter((p) => p.badge === 'NEW');
  const proven = live.filter((p) => p.badge === 'BESTSELLER');
  const seen = new Set<string>();
  const picks = [...fresh, ...proven].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return (picks.length ? picks : live).slice(0, n);
}
// Mobile drawer navigation: New In + every visible category.
// (Account / Our Story are appended by the drawer itself.)
export function sidebarNav(): NavLink[] {
  return [
    { label: 'New In', handle: 'new' },
    ...visibleCategoryNames().map((name) => ({ label: name, handle: name })),
  ];
}
// Header navigation, driven by admin settings:
// - New In / Best Sellers are badge shortcuts, always present
// - Hoodies / Sets follow their categories' visibility
// - Clothing (all) is always present
export type NavLink = { label: string; handle: string };
export function headerNav(): NavLink[] {
  const cats = visibleCategoryNames();
  const links: NavLink[] = [{ label: 'New In', handle: 'new' }, { label: 'Clothing', handle: 'all' }];
  if (cats.includes('Hoodies')) links.push({ label: 'Hoodies', handle: 'Hoodies' });
  if (cats.includes('Matching Sets')) links.push({ label: 'Sets', handle: 'Matching Sets' });
  links.push({ label: 'Best Sellers', handle: 'best' });
  return links;
}
