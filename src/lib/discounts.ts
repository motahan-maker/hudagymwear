// Discount codes: created in the admin dashboard, validated at checkout.
import { money } from './catalog';
import { getSupabase } from './supabase';
export type Discount = {
  code: string;
  kind: 'percent' | 'flat';
  value: number; // percent (0-90) or GBP amount
  minSpend: number;
  maxUses: number | null; // null = unlimited
  uses: number;
  active: boolean;
  startsAt?: string; // ISO date or ''
  endsAt?: string; // ISO date or ''
};

const KEY = 'huda.discounts.v1';
const seeds: Discount[] = [
  { code: 'WELCOME10', kind: 'percent', value: 10, minSpend: 0, maxUses: null, uses: 0, active: true },
  { code: 'SCULPT15', kind: 'percent', value: 15, minSpend: 60, maxUses: 200, uses: 0, active: true },
];
function readAll(): Discount[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Discount[];
  } catch { /* ignore */ }
  // Demo codes exist in dev only — production starts with no discount codes.
  if (!import.meta.env.DEV) return [];
  try { localStorage.setItem(KEY, JSON.stringify(seeds)); } catch { /* ignore */ }
  return seeds.map((d) => ({ ...d }));
}
function writeAll(list: Discount[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
export function listDiscounts(): Discount[] {
  return readAll();
}
export function saveDiscount(d: Discount) {
  const code = d.code.trim().toUpperCase();
  const list = readAll();
  const next = { ...d, code };
  writeAll(list.some((x) => x.code === code) ? list.map((x) => (x.code === code ? next : x)) : [...list, next]);
}
export function deleteDiscount(code: string) {
  writeAll(readAll().filter((x) => x.code !== code));
}
export function validateDiscount(rawCode: string, subtotal: number): { ok: boolean; amount: number; message: string } {
  const code = rawCode.trim().toUpperCase();
  const d = readAll().find((x) => x.code === code);
  if (!d) return { ok: false, amount: 0, message: 'This code is not valid.' };
  if (!d.active) return { ok: false, amount: 0, message: 'This code is no longer active.' };
  const now = new Date().toISOString().slice(0, 10);
  if (d.startsAt && now < d.startsAt) return { ok: false, amount: 0, message: 'This code is not active yet.' };
  if (d.endsAt && now > d.endsAt) return { ok: false, amount: 0, message: 'This code has expired.' };
  if (d.maxUses != null && d.uses >= d.maxUses) return { ok: false, amount: 0, message: 'This code has reached its usage limit.' };
  if (subtotal < d.minSpend) return { ok: false, amount: 0, message: `Requires a minimum spend of ${money(d.minSpend)}.` };
  const amount = d.kind === 'percent' ? Math.min(subtotal, (subtotal * d.value) / 100) : Math.min(subtotal, d.value);
  return { ok: true, amount: Math.round(amount * 100) / 100, message: `${code} applied.` };
}
export function recordDiscountUse(code: string) {
  // In Supabase mode the server trigger counts uses atomically on order
  // insert — a client-side increment would double-count, so do nothing.
  if (getSupabase()) return;
  writeAll(readAll().map((x) => (x.code === code ? { ...x, uses: x.uses + 1 } : x)));
}
type DiscountRow = {
  code: string; kind: string; value: number | string; min_spend: number | string;
  max_uses: number | null; uses: number | string; active: boolean;
  starts_at: string | null; ends_at: string | null;
};
function toDiscount(r: DiscountRow): Discount {
  const base: Discount = {
    code: r.code,
    kind: r.kind === 'flat' ? 'flat' : 'percent',
    value: Number(r.value ?? 0),
    minSpend: Number(r.min_spend ?? 0),
    maxUses: r.max_uses,
    uses: Number(r.uses ?? 0),
    active: r.active,
  };
  if (r.starts_at) base.startsAt = String(r.starts_at).slice(0, 10);
  if (r.ends_at) base.endsAt = String(r.ends_at).slice(0, 10);
  return base;
}
// Server is truth in Supabase mode: overwrite the local copy (even if empty).
export async function hydrateDiscounts(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data, error } = await sb.from('discounts').select('*');
    if (error) return;
    const mapped = ((data ?? []) as DiscountRow[]).map(toDiscount);
    writeAll(mapped);
  } catch { /* ignore — demo mode keeps local data */ }
}
// Cart → checkout handoff: the validated code travels with the shopper.
const PENDING_KEY = 'huda.promo.v1';
export function setPendingPromo(code: string) {
  try {
    if (code.trim()) localStorage.setItem(PENDING_KEY, code.trim().toUpperCase());
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* ignore */ }
}
export function getPendingPromo(): string | null {
  try { return localStorage.getItem(PENDING_KEY); } catch { return null; }
}
export function clearPendingPromo() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}
