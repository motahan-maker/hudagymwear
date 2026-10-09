// Discount codes: created in the admin dashboard, validated at checkout.
import { useSyncExternalStore } from 'react';
import { money } from './catalog';
import { getSupabase } from './supabase';
import { broadcastStoreEvent, subscribeToStoreEvent } from './realtime';

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
  if (!import.meta.env.DEV) return [];
  try { localStorage.setItem(KEY, JSON.stringify(seeds)); } catch { /* ignore */ }
  return seeds.map((d) => ({ ...d }));
}

function writeAll(list: Discount[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// In-memory reactive state
let memoryDiscounts: Discount[] = readAll();
const discountListeners = new Set<() => void>();

export function subscribeDiscounts(listener: () => void): () => void {
  discountListeners.add(listener);
  return () => {
    discountListeners.delete(listener);
  };
}

function notifyDiscountsChanged() {
  discountListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

export function listDiscounts(): Discount[] {
  return memoryDiscounts;
}

export function useDiscounts(): Discount[] {
  return useSyncExternalStore(
    subscribeDiscounts,
    listDiscounts,
    listDiscounts
  );
}

export function saveDiscount(d: Discount) {
  const code = d.code.trim().toUpperCase();
  const list = readAll();
  const next = { ...d, code };
  const updated = list.some((x) => x.code === code) ? list.map((x) => (x.code === code ? next : x)) : [...list, next];
  memoryDiscounts = updated;
  writeAll(updated);
  notifyDiscountsChanged();
  broadcastStoreEvent('discounts:changed', { action: 'save', code });

  const sb = getSupabase();
  if (!sb) return;
  void sb.from('discounts').upsert({
    code: next.code,
    kind: next.kind,
    value: next.value,
    min_spend: next.minSpend,
    max_uses: next.maxUses,
    uses: next.uses,
    active: next.active,
    starts_at: next.startsAt ? new Date(next.startsAt).toISOString() : null,
    ends_at: next.endsAt ? new Date(next.endsAt).toISOString() : null,
  }, { onConflict: 'code' });
}

export function deleteDiscount(code: string) {
  const c = code.trim().toUpperCase();
  const updated = readAll().filter((x) => x.code !== c);
  memoryDiscounts = updated;
  writeAll(updated);
  notifyDiscountsChanged();
  broadcastStoreEvent('discounts:changed', { action: 'delete', code: c });

  const sb = getSupabase();
  if (!sb) return;
  void sb.from('discounts').delete().eq('code', c);
}

export function validateDiscount(rawCode: string, subtotal: number): { ok: boolean; amount: number; message: string } {
  const code = rawCode.trim().toUpperCase();
  const d = memoryDiscounts.find((x) => x.code === code);
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
  if (getSupabase()) return;
  const updated = readAll().map((x) => (x.code === code ? { ...x, uses: x.uses + 1 } : x));
  memoryDiscounts = updated;
  writeAll(updated);
  notifyDiscountsChanged();
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

export async function hydrateDiscounts(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data, error } = await sb.from('discounts').select('*');
    if (error || !data) return;
    const mapped = (data as DiscountRow[]).map(toDiscount);
    memoryDiscounts = mapped;
    writeAll(mapped);
    notifyDiscountsChanged();
  } catch { /* ignore */ }
}

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

// Hook into realtime events automatically
if (typeof window !== 'undefined') {
  subscribeToStoreEvent('discounts:changed', () => {
    void hydrateDiscounts();
  });
}
