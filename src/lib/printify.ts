// src/lib/printify.ts — the browser half of the Printify integration
//
// WHAT THIS FILE IS ALLOWED TO KNOW
//   Nothing about Printify. No token, no base URL, no secret. This module only
//   POSTs an action name to the `printify` Edge Function with the signed-in
//   staff member's own Supabase access token, and re-shapes whatever comes back.
//   The Edge Function (supabase/functions/printify/index.ts) is the only place
//   the Personal Access Token exists, and it never returns it.
//
// WHY IT IS INERT WITHOUT SUPABASE
//   The rest of this app falls back to localStorage in demo mode. Fulfilment
//   cannot: charging a real card is not something a demo may do. So every call
//   here returns an `unavailable` result when there is no Supabase project, and
//   the admin screen says so instead of pretending to work.
//
// SECURITY NOTE FOR CALLERS
//   <AdminGuard> decides what to RENDER. It is not what authorises anything —
//   the Edge Function re-verifies the session and profiles.role on every call.

import { getSupabase, isSupabaseConfigured } from './supabase';

export type PrintifyShop = { id: string; title: string; sales_channel: string };

/**
 * A Printify shop-product variant, as much of it as the admin screen reads.
 *
 * A shop product's variant carries option IDS (`options: [1189, 1191]`); the
 * labels live on the parent product's `options` list. The admin screen only
 * needs to know which colours a product offers, so the resolution is done by
 * the server and the browser is handed plain names. Mapping itself is NOT done
 * here — that is the server's job.
 */
export type PrintifyVariant = {
  id?: number;
  size?: string;
  colour?: string;
  name?: string;
  available?: boolean;
  options?: ({ name?: string; value?: string } | number)[];
};

/** Distinct colour names a Printify product actually offers. */
export function variantColours(variants: PrintifyVariant[] | undefined): string[] {
  const out = new Set<string>();
  for (const v of variants ?? []) {
    const opt = (v.options ?? []).find(
      (o) => o && typeof o === 'object' && /^colou?r$/i.test(String((o as { name?: string }).name ?? '')),
    );
    const name = String(
      (opt && typeof opt === 'object' ? (opt as { value?: string }).value : undefined) ?? v.colour ?? v.name ?? '',
    ).trim();
    if (name) out.add(name);
  }
  return [...out];
}

export type PrintifyPendingProduct = {
  external_product_id: string;
  title: string;
  description?: string;
  status: string;
  cost_cents: number;
  cost_pounds: number;
  /** The currency the production cost is actually in. Blank = not confirmed. */
  cost_currency?: string;
  variants: PrintifyVariant[];
  variant_count: number;
  /** Variants that cannot be sold through the site model, with the reason. */
  unsupported?: { variant_id: number; reason: string }[];
  product_id: string | null;
  available: boolean;
  blueprint_id: number;
  print_provider_id: number;
};

export type PrintifyStatus = {
  has_token: boolean;
  token_hint: string;
  /** When the Personal Access Token expires. Blank = not recorded. */
  token_expires_at?: string;
  has_webhook_secret: boolean;
  enabled: boolean;
  shop_id: string;
  shop_title: string;
  auto_send_to_production: boolean;
  cod_fulfilment_allowed: boolean;
  cod_policy_note: string;
  cod_policy_at: string;
  last_test_at: string;
  last_test_ok: unknown;
  last_error: string;
  last_sync_at: string;
  /** The shops the last successful connection test returned. */
  shops?: PrintifyShop[];
  counts: { pending: number; imported: number; unsupported: number; archived: number };
  pending: PrintifyPendingProduct[];
  /** The webhook topics the receiver understands, supplied by the server. */
  webhook_topics?: string[];
  site: { base: string; webhook_target: string };
};

export type PrintifyQueueRow = {
  order_id: string;
  state: string;
  printify_order_id: string;
  attempts: number;
  last_error: string;
  printify_status: string;
  submitted_at: string;
  updated_at: string;
  customer: string;
  total: number;
  payment: string;
  payment_status: string;
  order_status: string;
  line_count: number;
  meaning: string;
  [key: string]: unknown;
};

export type PrintifyWebhook = { id: string; topic: string; url: string };

/** An unclaimed order that contains at least one mapped Printify line. */
export type PrintifyReadyOrder = {
  order_id: string;
  customer: string;
  total: number;
  payment: string;
  payment_status: string;
  order_status: string;
  created_at: string;
  printify_lines: number;
  other_lines: number;
  quantity: number;
  /** Why the claim would refuse right now, in plain words. Empty = sendable. */
  blocked: string;
};

/**
 * Fallback topics offered in the webhook panel.
 *
 * The authoritative list is the receiver's own `PRINTIFY_TOPICS`, which the
 * Edge Function returns in `status` as `webhook_topics`. This literal is only
 * used before the first status has loaded, and src/lib/printify.test.ts
 * asserts it stays a subset of the server's list, so the two cannot drift
 * apart unnoticed.
 */
export const WEBHOOK_TOPICS = [
  'order:shipment:created',
  'order:shipment:delivered',
  'order:updated',
];

/** A refusal the UI can explain, rather than a thrown error the UI swallows. */
export type Pfy<T extends object> =
  | ({ ok: true } & T)
  | ({ ok: false; error: string; state?: string; retriable?: boolean; printify_order_id?: string } & Record<string, unknown>);

const UNAVAILABLE = 'Printify runs server-side and needs a Supabase project. Demo mode has no fulfilment.' as const;

async function call<T extends object>(action: string, args: Record<string, unknown> = {}): Promise<Pfy<T>> {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: UNAVAILABLE, unavailable: true };
  let res;
  try {
    // supabase-js attaches the caller's own bearer token and POSTs the body.
    res = await sb.functions.invoke('printify', { body: { action, ...args } });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'the Printify service could not be reached' };
  }
  // Non-2xx still carries our JSON envelope in `data`, and that message is the
  // useful one ("test the connection first", "bank transfer not paid yet").
  const body = (res.data ?? {}) as Record<string, unknown>;
  if (body && typeof body === 'object' && 'ok' in body) {
    if (body['ok'] === true) return { ...body, ok: true } as Pfy<T>;
    return {
      ...body,
      ok: false,
      error: typeof body['error'] === 'string' ? body['error'] : 'the request was refused',
    } as Pfy<T>;
  }
  return { ok: false, error: res.error?.message || 'the Printify service returned an unexpected reply' };
}

// ---------------------------------------------------------------- connection
export const printifyReady = () => isSupabaseConfigured;

export const getStatus = () => call<PrintifyStatus>('status');
export const saveToken = (token: string) => call<{ saved: boolean; note: string }>('saveToken', { token });
export const testConnection = () => call<{ shops: PrintifyShop[] }>('testConnection');
export const selectShop = (shop_id: string, shop_title: string) => call<{ shop_id: string; shop_title: string }>('selectShop', { shop_id, shop_title });
export const setEnabled = (enabled: boolean) => call<{ enabled: boolean }>('setEnabled', { enabled });
export const setAutoProduction = (enabled: boolean) => call<{ auto_send_to_production: boolean }>('setAutoProduction', { enabled });
/** The note is the authorisation record: ≥20 characters, stamped with who wrote it. */
export const setCodPolicy = (allowed: boolean, note: string) =>
  call<{ cod_fulfilment_allowed: boolean; note: string }>('setCodPolicy', { allowed, note });

// ---------------------------------------------------------------- catalogue
export const syncProducts = () => call<{ fetched: number; created: number; updated: number; archived: number; unsupported: number }>('sync');
export type ImportInput = {
  external_product_id: string;
  name: string;
  category: string;
  retail_price: number;
  tone?: string;
  colours?: { name: string; tone?: string }[];
};
export const importProduct = (input: ImportInput) =>
  call<{ product_id: string; mapped: number; unsupported: unknown[]; reason?: string; cost_pounds: number; margin_pounds: number }>('import', { ...input });
export const publishProduct = (external_product_id: string) =>
  call<{ published: boolean; note: string }>('publish', { external_product_id });

// ---------------------------------------------------------------- fulfilment
export const fulfil = (order_id: string) => call<{ state: string; submitted_lines: number; held_back_lines: number; production: string; reconciled_from_duplicate: boolean }>('fulfil', { order_id });
export const retryFulfilment = (order_id: string) => call<{ state: string; submitted_lines: number; held_back_lines: number; production: string }>('retry', { order_id });
export const refreshOrder = (order_id: string) => call<{ printify_status: string; meaning: string; shipments_reconciled: number; tracking: { carrier: string; number: string; url: string; delivered_at: string }[] }>('refreshOrder', { order_id });
export const getQueue = () => call<{ queue: PrintifyQueueRow[] }>('queue');
/** Orders nobody has tried to send yet — the entry point for a first submission. */
export const getReady = () => call<{ ready: PrintifyReadyOrder[]; note?: string }>('ready');

// ---------------------------------------------------------------- webhooks
export const listWebhooks = () => call<{ webhooks: PrintifyWebhook[] }>('listWebhooks');
export const registerWebhook = (topic: string) => call<{ webhook_id: string; topic: string; url: string; signature_expected: string }>('registerWebhook', { topic });
export const deleteWebhook = (webhook_id: string) => call<{ deleted: string }>('deleteWebhook', { webhook_id });
