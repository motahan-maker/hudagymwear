// Operational shop settings (admin-editable). Pure data — never site copy.
// Stored in localStorage now; maps 1:1 to a future Supabase `shop_settings` row.
import { getSupabase } from './supabase';
export type ShippingMethod = { id: string; label: string; hint: string; price: number; enabled: boolean };
export type ShopSettings = {
  announcement: string;
  whatsapp: string; // digits only, e.g. "447911123456" (wa.me format, no +)
  instagram: string; // full URL
  facebook: string; // full URL, empty = hidden
  tiktok: string; // full URL, empty = hidden
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  shipping: ShippingMethod[];
  freeOver: number; // free STANDARD delivery threshold (GBP)
  lowStockAt: number; // "running low" threshold (units)
};

const KEY = 'huda.settings.v1';
export const DEFAULT_SHIPPING: ShippingMethod[] = [
  { id: 'standard', label: 'UK standard delivery', hint: '2–4 working days', price: 3.95, enabled: true },
  { id: 'express', label: 'UK express delivery', hint: 'Next working day', price: 6.95, enabled: true },
];
const defaults: ShopSettings = {
  announcement: 'DESIGNED FOR YOUR EVERYDAY. MADE FOR YOUR NEXT LEVEL.',
  whatsapp: '',
  instagram: 'https://www.instagram.com/',
  facebook: '',
  tiktok: '',
  bankName: '',
  accountName: 'HUDA GYMWEAR LTD',
  accountNumber: '',
  iban: '',
  shipping: DEFAULT_SHIPPING,
  freeOver: 100,
  lowStockAt: 5,
};

export function getSettings(): ShopSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<ShopSettings>) };
  } catch { /* ignore */ }
  return { ...defaults };
}
type ShopSettingsRow = {
  id: number; announcement: string; whatsapp: string; instagram: string;
  facebook: string; tiktok: string; bank_name: string; account_name: string;
  account_number: string; iban: string; shipping: unknown;
  free_over: number | string; low_stock_at: number | string;
};
// Server is truth in Supabase mode: overwrite the local copy with row id=1.
export async function hydrateSettings(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data, error } = await sb.from('shop_settings').select('*').eq('id', 1).maybeSingle();
    if (error || !data) return;
    const r = data as ShopSettingsRow;
    let shipping: ShippingMethod[] = DEFAULT_SHIPPING;
    try {
      const raw = typeof r.shipping === 'string' ? JSON.parse(r.shipping) : r.shipping;
      if (Array.isArray(raw)) shipping = raw as ShippingMethod[];
    } catch { /* keep defaults */ }
    const mapped: ShopSettings = {
      announcement: r.announcement ?? defaults.announcement,
      whatsapp: r.whatsapp ?? '',
      instagram: r.instagram ?? defaults.instagram,
      facebook: r.facebook ?? '',
      tiktok: r.tiktok ?? '',
      bankName: r.bank_name ?? '',
      accountName: r.account_name ?? defaults.accountName,
      accountNumber: r.account_number ?? '',
      iban: r.iban ?? '',
      shipping,
      freeOver: Number(r.free_over ?? defaults.freeOver),
      lowStockAt: Number(r.low_stock_at ?? defaults.lowStockAt),
    };
    try { localStorage.setItem(KEY, JSON.stringify(mapped)); } catch { /* ignore */ }
  } catch { /* ignore — demo mode keeps local data */ }
}
export function updateSettings(patch: Partial<ShopSettings>): Promise<ShopSettings> {
  const next = { ...getSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  const sb = getSupabase();
  if (!sb) return Promise.resolve(next);
  return (async () => {
    try {
      await sb.from('shop_settings').update({
        announcement: next.announcement,
        whatsapp: next.whatsapp,
        instagram: next.instagram,
        facebook: next.facebook,
        tiktok: next.tiktok,
        bank_name: next.bankName,
        account_name: next.accountName,
        account_number: next.accountNumber,
        iban: next.iban,
        shipping: next.shipping,
        free_over: next.freeOver,
        low_stock_at: next.lowStockAt,
      }).eq('id', 1);
    } catch { /* ignore — RLS enforces admin */ }
    return next;
  })();
}
// wa.me deep link with a pre-filled order message (no WhatsApp API involved).
export function whatsappLink(message: string): string | null {
  const number = getSettings().whatsapp.replace(/\D/g, '');
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
