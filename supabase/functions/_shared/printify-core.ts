// supabase/functions/_shared/printify-core.ts
//
// The pure half of the Printify integration. Deliberately free of runtime
// APIs so the SAME module runs in three places:
//   1. the `printify` Edge Function (Deno) that brokers Printify calls,
//   2. the `printify-webhook` Edge Function that verifies deliveries,
//   3. the browser (`src/lib/printify.ts`) for admin previews, and vitest.
//
// It therefore uses only: plain objects, string ops, and Web Crypto via
// globalThis.crypto — no Deno.*, no node:*, no import.meta.env.
//
// SCHEMA NOTE — this is written against the CURRENT Printify Public API
// (developers.printify.com + openapi.json, checked 2026-10). The older
// integrator vocabulary is gone and using it returns 404/400:
//   POST /shops/{id}/printify_orders.json  ->  POST /shops/{id}/orders.json
//   items[] / printify_product_id          ->  line_items[] / product_id
//   shipping_to                            ->  address_to
//   label_id / label_template_id           ->  label
//   per-order cost / currency request      ->  removed; costs are Printify-side
//   PENDING / IN_PRODUCTION / IN_TRANSIT   ->  pending / in-production / fulfilled
//   GET /user/shops                        ->  GET /shops.json
//   Idempotency-Key header                 ->  does not exist; external_id + HTTP 409

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type PrintifyVariantOption = { name: string; value: string };

/** One value of a product option, e.g. { id: 1189, title: "XS" }. */
export type PrintifyOptionValue = { id?: number; title?: string };

/**
 * A product-level option definition, e.g.
 * `{ name: "Sizes", type: "size", values: [{ id: 1189, title: "XS" }] }`.
 *
 * A shop product's VARIANT carries only option IDS (`options: [1189, 1191]`).
 * The readable labels — and, crucially, which axis each option belongs to —
 * live here on the parent product. Without resolving the ids against this
 * list a variant has no known size or colour, and every variant would fall
 * into review as "no size axis recognised".
 */
export type PrintifyProductOption = {
  name?: string;
  type?: string;
  values?: PrintifyOptionValue[];
};

/**
 * A production mockup. Note this is an OBJECT, not a URL string:
 * `{ src, variant_ids, position, is_default }`.
 */
export type PrintifyProductImage = {
  src?: string;
  variant_ids?: number[];
  position?: string;
  is_default?: boolean;
};

export type PrintifyVariant = {
  id: number;
  sku?: string;
  /** Production cost in MINOR units (cents). Never a sell price. */
  cost?: number;
  price?: number;
  is_enabled?: boolean;
  is_available?: boolean;
  /**
   * Option ids on a shop product (`[1189, 1191]`), or spelled-out pairs on a
   * catalog variant (`[{ name, value }]`). Both are accepted.
   */
  options?: (number | PrintifyVariantOption)[];
};

export type PrintifyShopProduct = {
  id: string;
  shop_id?: number;
  blueprint_id?: number;
  print_provider_id?: number;
  title?: string;
  description?: string | null;
  /** Production mockups. Each entry is an object, not a URL string. */
  images?: PrintifyProductImage[];
  /** The option definitions the variant ids refer to. */
  options?: PrintifyProductOption[];
  visible?: boolean;
  is_locked?: boolean;
  variants?: PrintifyVariant[];
  print_areas?: unknown[];
  tags?: string[];
};

export type PrintifyShop = { id: number; title: string; sales_channel?: string };

/**
 * The production mockup URLs of a shop product.
 *
 * `product.images` is a list of OBJECTS (`{ src, variant_ids, position,
 * is_default }`), not a list of URL strings. Reading it as strings yields
 * nothing, which is how a synced catalogue ends up with no imagery at all.
 */
export function productImageUrls(images: PrintifyProductImage[] | undefined): string[] {
  const out: string[] = [];
  for (const image of images ?? []) {
    const src = String(image?.src ?? '').trim();
    if (src) out.push(src);
  }
  return out;
}

/** Website-owned line shape (mirrors Order['items'][n] in src/lib/orders.ts). */
export type SiteOrderLine = {
  productId: string;
  name: string;
  colour: string;
  size: string;
  qty: number;
};

export type VariantMapRow = {
  size: string;
  colour: string;
  printify_variant_id: number;
  sku: string;
  cost_cents: number;
  available: boolean;
};

export type NormalizedEvent = {
  event_id: string;
  topic: string;
  resource_type: string;
  resource_id: string;
  /** Printify's own order id, when the event carries one. */
  printify_order_id: string;
  /** Printify status string for order:updated events. */
  printify_status: string;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
  /** 'shipped' | 'delivered' | '' — only shipment topics produce these. */
  movement: string;
  occurred_at: string;
  raw: unknown;
};

// ---------------------------------------------------------------------------
// 1. Webhook authenticity
// ---------------------------------------------------------------------------
// Printify signs deliveries with header `X-Pfy-Signature: sha256=<hex>`, the
// HMAC-SHA256 of the RAW request body keyed with the per-webhook secret.
// Rules that matter, in order:
//   * verify against the raw bytes, never a re-serialised object — a
//     re-encode changes key order/whitespace and silently fails for real
//     deliveries while passing your own tests;
//   * compare in constant time over the full `sha256=<hex>` string;
//   * refuse when no secret is configured — an unconfigured verifier is an
//     open door, not a disabled feature.
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!secret) return false;
  if (!signatureHeader) return false;
  const provided = signatureHeader.trim();
  if (!/^sha256=[0-9a-f]{64}$/i.test(provided)) return false;

  const expected = 'sha256=' + await hmacHex(secret, rawBody);
  return constantTimeEqual(provided, expected);
}

/** Web Crypto HMAC-SHA256 -> lowercase hex. */
export async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(body));
  return hex(new Uint8Array(sig));
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Length-independent constant-time compare (timing-safe token check). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Equalise length so an early return on length cannot leak it.
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// 2. Event envelope + dedup identity
// ---------------------------------------------------------------------------
export const PRINTIFY_TOPICS = [
  'shop:disconnected',
  'product:created',
  'product:updated',
  'product:deleted',
  'product:publish:started',
  'order:created',
  'order:updated',
  'order:sent-to-production',
  'order:shipment:created',
  'order:shipment:delivered',
  'order:line-item:canceled',
] as const;

/** Topics that may move the customer timeline, and only forward. */
const MOVEMENT_BY_TOPIC: Record<string, string> = {
  'order:shipment:created': 'shipped',
  'order:shipment:delivered': 'delivered',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};

/**
 * Flatten a Printify webhook envelope into one shape the DB functions consume.
 * Printify has written the tracking details in more than one shape, and the
 * receiver cannot ask for another field, so every documented position is read:
 *   event resource.data.carrier = { code, tracking_number, tracking_url }
 *   event resource.data.carrier = "DPD" with data.tracking_number alongside
 *   order object .shipments[]   = { carrier, number, url }   (refresh path)
 *
 * `resource.id` is the ORDER id for order:* events but the SHIPMENT id for
 * shipment events, whose data carries `order_id` — so the order id prefers the
 * body and falls back to the resource. Getting this wrong would make every
 * tracking event "not one of our orders" and the timeline would never move.
 */
export function normalizeEvent(body: unknown): NormalizedEvent {
  const env = obj(body);
  const resource = obj(env['resource']);
  const data = obj(resource['data']);
  const carrierObj = obj(data['carrier']);

  const topic = str(env['type']);
  const movement = MOVEMENT_BY_TOPIC[topic] ?? '';

  const shippedAt = str(data['shipped_at']) || (movement === 'shipped' ? str(env['created_at']) : '');
  const deliveredAt = str(data['delivered_at']) || (movement === 'delivered' ? str(env['created_at']) : '');

  return {
    // Dedup identity, see derivedEventId().
    event_id: derivedEventId(env, topic),
    topic,
    resource_type: str(resource['type']),
    resource_id: str(resource['id']),
    printify_order_id: str(data['order_id']) || str(resource['id']),
    printify_status: str(data['status']),
    carrier: str(carrierObj['code']) || str(carrierObj['name']) || str(data['carrier']),
    tracking_number: str(carrierObj['tracking_number']) || str(carrierObj['number']) || str(data['tracking_number']),
    tracking_url: str(carrierObj['tracking_url']) || str(carrierObj['url']) || str(data['tracking_url']),
    movement: movement || (deliveredAt && !shippedAt ? 'delivered' : ''),
    occurred_at: shippedAt || deliveredAt || str(env['created_at']),
    raw: body,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The events table is keyed by uuid, so every delivery needs a stable uuid.
 * Printify documents `id` as a uuid, but a simulate call or a future payload
 * change could hand us something else; in that case we DERIVE a uuid from the
 * SHA-256 of topic + order + body, which keeps retries of the same delivery
 * idempotent instead of throwing them away as unparseable.
 */
export function derivedEventId(env: Record<string, unknown>, topic: string): string {
  const raw = str(env['id']);
  if (UUID_RE.test(raw)) return raw.toLowerCase();
  return '';
}

/** Deterministic uuid-shaped identity from the sha256 of a string. */
export function uuidFromDigest(digestHex: string): string {
  // 32 hex chars, coerced to lowercase and padded so a short/garbage digest
  // still yields a structurally valid uuid.
  const clean = (String(digestHex ?? '').toLowerCase().replace(/[^0-9a-f]/g, '') + '0'.repeat(64)).slice(0, 32);
  const variant = ((parseInt(clean[16] ?? '0', 16) & 0b0011) | 0b1000).toString(16);
  return (
    clean.slice(0, 8) + '-' + clean.slice(8, 12) + '-4' + clean.slice(13, 16) +
    '-' + variant + clean.slice(17, 20) + '-' + clean.slice(20, 32)
  );
}

/** sha256 hex of a string via Web Crypto (for the fallback event identity). */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(buf));
}

/**
 * Event id for storage. Prefers Printify's own uuid; otherwise derives one from
 * the digest of topic + resource + body so a retried delivery still maps to the
 * same row. `stableKey` is what the caller has when the payload had no id.
 */
export async function resolveEventId(ev: { topic: string; resource_id: string }, body: unknown): Promise<string> {
  const direct = derivedEventId(obj(body), ev.topic);
  if (direct) return direct;
  return uuidFromDigest(await sha256Hex(`${ev.topic}|${ev.resource_id}|${JSON.stringify(body)}`));
}

// ---------------------------------------------------------------------------
// 3. Variant mapping: Printify options -> the site's colour + size model
// ---------------------------------------------------------------------------
// The storefront sells exactly two axes (src/lib/catalog.ts `sizes` XS-XL and a
// named colour per product). Printify variants carry an arbitrary option list.
// Anything that is not a single size axis + one colour axis, or that has no
// matching site colour/size, is returned as UNSUPPORTED and must land in
// review — never in a purchasable state.
export const SITE_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', 'One size'];

const SIZE_ALIASES: Record<string, string> = {
  xsmall: 'XS', extra_small: 'XS', 'extra-small': 'XS', xs: 'XS',
  small: 'S', s: 'S',
  medium: 'M', m: 'M',
  large: 'L', l: 'L',
  xlarge: 'XL', extra_large: 'XL', 'extra-large': 'XL', xl: 'XL',
  xxlarge: 'XXL', '2xl': 'XXL', xxl: 'XXL',
  '3x': '3XL', '3xl': '3XL', xxxlarge: '3XL',
  onesize: 'One size', 'one size': 'One size', 'no size': 'One size',
};

/**
 * One canonical spelling per size. This matters beyond tidiness: the variant map
 * stores what this function returns, and the fulfilment claim compares it against
 * the order line as text. If '2XL' and '2 XL' canonicalised differently, a mapped
 * variant would silently stop matching its own product.
 */
export function normalizeSize(value: string): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  // Aliases are checked BEFORE the size list, so every double-XL spelling lands on
  // 'XXL' rather than some rows saying 'XXL' and others '2XL'.
  const key = raw.toLowerCase().replace(/[\s_.-]+/g, '_');
  const compact = raw.toLowerCase().replace(/[\s_.-]+/g, '');
  const alias = SIZE_ALIASES[key] ?? SIZE_ALIASES[compact];
  if (alias) return alias;
  if ((SITE_SIZES as string[]).includes(upper)) return upper;
  // Echoed back uppercased: mapVariants rejects anything outside SITE_SIZES, so a
  // provider's odd label lands in review with the word itself in the reason.
  return upper;
}

/** True only for a size the site can actually sell, not just any word. */
function isSiteSize(value: string): boolean {
  return (SITE_SIZES as string[]).includes(normalizeSize(value));
}

const SIZE_OPTION_NAMES = ['size', 'sizes', 'group size', 'sizing'];
const COLOUR_OPTION_NAMES = ['color', 'colour', 'colors', 'colours'];

/**
 * Normalise a variant's option list into `{name, value}` pairs.
 *
 * A shop product's variant carries only option IDS (`options: [1189, 1191]`).
 * The readable labels — and which axis each option belongs to — live on the
 * parent product:
 *
 *   product.options = [
 *     { name: "Sizes",  type: "size",  values: [{ id: 1189, title: "XS" }] },
 *     { name: "Colours", type: "color", values: [{ id: 1191, title: "Black" }] },
 *   ]
 *
 * The ids are resolved against that list here, so the axis logic below sees
 * one shape whichever way Printify spells it. An id the parent does not
 * define is reported as such rather than guessed at, because guessing a size
 * means producing the wrong garment.
 */
export function variantOptionPairs(
  variant: PrintifyVariant,
  productOptions: PrintifyProductOption[],
): { name: string; value: string }[] {
  const raw = variant.options ?? [];
  if (!raw.length) return [];

  // Spelled-out shape: the axes are already on the variant.
  if (typeof raw[0] === 'object' && raw[0] !== null) {
    return (raw as PrintifyVariantOption[]).map((o) => ({
      name: String(o?.name ?? ''),
      value: String(o?.value ?? ''),
    }));
  }

  // Ids: resolve each one against the parent product's option definitions.
  const byId = new Map<number, { name: string; value: string }>();
  for (const option of productOptions ?? []) {
    // `type` is the authoritative axis ("size", "color"); the display name is
    // "Sizes"/"Colours". Prefer the type, fall back to the name.
    const axis = String(option?.type ?? '').trim().toLowerCase()
      || String(option?.name ?? '').trim().toLowerCase();
    for (const value of option?.values ?? []) {
      if (typeof value?.id === 'number') {
        byId.set(value.id, { name: axis, value: String(value?.title ?? '').trim() });
      }
    }
  }

  return (raw as number[]).map((id) => {
    const found = typeof id === 'number' ? byId.get(id) : undefined;
    if (found) return found;
    // Unresolvable: name it so the review list says which id was unknown.
    return { name: `option ${id}`, value: '' };
  });
}

/** Which axis of a Printify variant is size vs colour, by option name. */
function classifyOptions(
  variant: PrintifyVariant,
  productOptions: PrintifyProductOption[],
): { size: string; colour: string; unknown: string[] } {
  let size = '';
  let colour = '';
  const unknown: string[] = [];
  for (const opt of variantOptionPairs(variant, productOptions)) {
    const name = (opt?.name ?? '').trim().toLowerCase();
    const value = (opt?.value ?? '').trim();
    if (SIZE_OPTION_NAMES.includes(name) && !size) { size = normalizeSize(value); continue; }
    if (COLOUR_OPTION_NAMES.includes(name) && !colour) { colour = value; continue; }
    // Unnamed axes that still look like a size/colour can be absorbed once
    // each; a second one is genuinely a third dimension we cannot sell.
    if (!size && isSiteSize(value)) { size = normalizeSize(value); continue; }
    if (!colour && siteColoursLookLikeColour(value)) { colour = value; continue; }
    // The reason string is what the admin reads in the review list, so an
    // unnamed axis is labelled rather than printed as "undefined: Relaxed".
    unknown.push(`${(opt?.name ?? '').trim() || "unnamed option"}: ${value}`);
  }
  return { size, colour, unknown };
}

/**
 * Heuristic for an option list that omits the axis NAME (Printify does this on
 * some apparel): only accept it as a colour when it is not a size and is a
 * plausible colour-ish label. Anything exotic falls through to `unknown` and
 * lands in review instead of being guessed at.
 */
function siteColoursLookLikeColour(value: string): boolean {
  const v = (value ?? '').trim();
  if (!v) return false;
  // normalizeSize() echoes unknown words back uppercased, so "is a size" has to
  // be tested against SITE_SIZES — otherwise every label looks like a size and
  // this heuristic can never fire.
  if (isSiteSize(v)) return false;
  return v.length <= 28 && !/\d/.test(v);
}

/**
 * Case-insensitive colour match against the website's colour names. Returns the
 * site spelling so variant_map rows key the same string the order line holds,
 * or '' when Printify's colour has no counterpart on the site.
 */
export function matchSiteColour(printifyColour: string, siteColours: string[]): string {
  const needle = (printifyColour ?? '').trim().toLowerCase();
  if (!needle) return '';
  const exact = siteColours.find((c) => c.toLowerCase() === needle);
  if (exact) return exact;
  const contains = siteColours.find((c) => {
    const hay = c.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
  return contains ?? '';
}

export type MappingResult = {
  supported: VariantMapRow[];
  /** Variant ids that cannot be sold through the site model, with the reason. */
  unsupported: { variant_id: number; reason: string }[];
};

/**
 * The variants that carry no recognisable size axis.
 *
 * This is the failure a product hits BEFORE it is imported: the admin sees a
 * product in the Printify catalogue but the site model cannot express its
 * sizes, so it can never be produced. It deliberately does not need the site's
 * own colour list, which only exists once the product has been imported.
 */
export function variantsWithoutSize(
  variants: PrintifyVariant[],
  productOptions: PrintifyProductOption[],
): { variant_id: number; reason: string }[] {
  const out: { variant_id: number; reason: string }[] = [];
  for (const v of variants ?? []) {
    if (typeof v?.id !== 'number') {
      out.push({ variant_id: -1, reason: 'variant has no id' });
      continue;
    }
    if (v.is_enabled === false) {
      out.push({ variant_id: v.id, reason: 'variant disabled on Printify' });
      continue;
    }
    const { size, unknown } = classifyOptions(v, productOptions);
    if (unknown.length) {
      out.push({ variant_id: v.id, reason: `unsupported options: ${unknown.join(', ')}` });
      continue;
    }
    if (!size) {
      out.push({ variant_id: v.id, reason: 'no size axis recognised' });
    }
  }
  return out;
}

/**
 * Turn Printify variants into trusted (size, colour) -> variant id rows.
 *
 * `productOptions` is the parent product's option definitions — the ids on
 * each variant are resolved against it, because the variant alone does not say
 * which axis an option belongs to. `siteColours` is the product's own colour
 * list; a blank list means the product is single-colour and Printify's colour
 * axis is ignored.
 */
export function mapVariants(
  variants: PrintifyVariant[],
  productOptions: PrintifyProductOption[],
  siteColours: string[],
): MappingResult {
  const supported: VariantMapRow[] = [];
  const unsupported: { variant_id: number; reason: string }[] = [];

  for (const v of variants ?? []) {
    if (typeof v?.id !== 'number') {
      unsupported.push({ variant_id: -1, reason: 'variant has no id' });
      continue;
    }
    if (v.is_enabled === false) {
      unsupported.push({ variant_id: v.id, reason: 'variant disabled on Printify' });
      continue;
    }
    const { size, colour, unknown } = classifyOptions(v, productOptions);
    if (unknown.length) {
      // A third axis (e.g. cup size, fit, fabric) cannot be represented by
      // productId/size/colour, so this combination must not be sold blind.
      unsupported.push({ variant_id: v.id, reason: `unsupported options: ${unknown.join(', ')}` });
      continue;
    }
    if (!size) {
      unsupported.push({ variant_id: v.id, reason: 'no size axis recognised' });
      continue;
    }
    if (!(SITE_SIZES as string[]).includes(size)) {
      unsupported.push({ variant_id: v.id, reason: `size "${size}" is not sold on this site` });
      continue;
    }
    const matched = siteColours.length ? matchSiteColour(colour, siteColours) : (siteColours[0] ?? '');
    if (siteColours.length && !matched) {
      unsupported.push({ variant_id: v.id, reason: `colour "${colour}" has no website equivalent` });
      continue;
    }
    supported.push({
      size,
      colour: matched || (siteColours[0] ?? ''),
      printify_variant_id: v.id,
      sku: v.sku ?? '',
      // Provider cost, minor units. Deliberately not converted into a price.
      cost_cents: typeof v.cost === 'number' ? Math.max(0, Math.round(v.cost)) : 0,
      available: v.is_available !== false,
    });
  }

  return { supported, unsupported };
}

// ---------------------------------------------------------------------------
// 4. Fulfilment eligibility for a mixed order
// ---------------------------------------------------------------------------
export type LineSplit = {
  /** Indices of lines that Printify will produce. */
  printifyIndices: number[];
  /** Indices that stay on the existing order (hand-made, non-Printify). */
  otherIndices: number[];
};

/**
 * Which lines of an order are Printify-managed. Trusts the stored variant map
 * only: a line is Printify-managed when its product was imported AND its exact
 * size/colour pair has an available variant row.
 */
export function splitOrderLines(
  items: SiteOrderLine[],
  map: Record<string, VariantMapRow[]>,
): LineSplit {
  const printifyIndices: number[] = [];
  const otherIndices: number[] = [];
  (items ?? []).forEach((line, i) => {
    const rows = map[line.productId] ?? [];
    const hit = rows.find(
      (r) => r.available && normalizeSize(r.size) === normalizeSize(line.size) && r.colour === line.colour,
    );
    if (hit) printifyIndices.push(i);
    else otherIndices.push(i);
  });
  return { printifyIndices, otherIndices };
}

export type PaymentGate = 'allowed' | 'bank_unpaid' | 'cod_without_policy' | 'unknown';

/**
 * The payment/fulfilment separation, expressed once.
 * Bank transfer orders are blocked until the existing admin workflow has
 * confirmed the payment. COD stays sellable at checkout but only becomes
 * submittable after an admin records the funding/collection policy note —
 * Printify has no payment-collection endpoint and charges the merchant.
 */
export function paymentGate(
  payment: string,
  paymentStatus: string,
  codPolicyApproved: boolean,
): PaymentGate {
  if (payment === 'bank') return paymentStatus === 'Paid' ? 'allowed' : 'bank_unpaid';
  if (payment === 'cod') return codPolicyApproved ? 'allowed' : 'cod_without_policy';
  return 'unknown';
}

export const GATE_MESSAGE: Record<PaymentGate, string> = {
  allowed: '',
  bank_unpaid: 'Bank transfer has not been approved yet.',
  cod_without_policy: 'Cash on delivery needs a recorded funding/collection policy note.',
  unknown: 'Unrecognised payment method.',
};

// ---------------------------------------------------------------------------
// 5. Idempotency
// ---------------------------------------------------------------------------
/**
 * Printify rejects a second order carrying an already-used external_id with
 * HTTP 409 / code 8503 and returns the existing order id. There is no
 * Idempotency-Key header, so external_id IS the idempotency key — it must be
 * derived from the order, never from the attempt, or a retry after a dropped
 * response would create a second production order.
 */
export function externalIdFor(orderId: string): string {
  return orderId;
}

/** Per-line id so a multi-variant order can be reconciled back to our lines. */
export function lineExternalId(orderId: string, lineIndex: number): string {
  return `${orderId}:${lineIndex}`;
}

export type SubmitOutcome =
  | { kind: 'submitted'; printifyOrderId: string }
  /** Duplicate detected: treat as success and reconcile on the returned id. */
  | { kind: 'duplicate'; printifyOrderId: string }
  | { kind: 'rejected'; status: number; error: string; code?: number }
  | { kind: 'transient'; status: number; error: string };

/** Transient = safe to retry. Anything else needs a human look. */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DUPLICATE_CODE = 8503;

export function interpretSubmitResponse(
  status: number,
  body: unknown,
  fallbackOrderId = '',
): SubmitOutcome {
  const b = obj(body);
  const code = Number(b['code']) || 0;
  const bodyOrderId = str(b['id']) || str(obj(b['data'])['id']) || str(obj(b['order'])['id']);

  // A network failure, a timeout or a dropped connection reaches us as
  // status 0. Nothing was rejected by Printify, so it must not be reported as
  // a rejection: a rejection tells the admin the payload is wrong and to fix
  // it, when in fact the request simply did not get through. Retrying is safe
  // because external_id is the idempotency key — a duplicate comes back as a
  // 409 and is reconciled rather than produced twice.
  if (status === 0) {
    return { kind: 'transient', status, error: str(b['message']) || 'Printify could not be reached.' };
  }
  if (status >= 200 && status < 300) {
    const id = bodyOrderId || fallbackOrderId;
    return id
      ? { kind: 'submitted', printifyOrderId: id }
      : { kind: 'rejected', status, error: 'Printify accepted the order but returned no id.' };
  }
  if (status === 409 || code === DUPLICATE_CODE) {
    return { kind: 'duplicate', printifyOrderId: bodyOrderId };
  }
  if (TRANSIENT_STATUS.has(status)) {
    return { kind: 'transient', status, error: str(b['message']) || `HTTP ${status}` };
  }
  // The code is Printify's own error number and belongs in the audit row, but
  // `code?: number` under exactOptionalPropertyTypes means "omit it", not "set
  // it to undefined" — so it is spread only when there is one.
  return {
    kind: 'rejected', status, error: str(b['message']) || `HTTP ${status}`,
    ...(code ? { code } : {}),
  };
}

/** Does a 409 duplicate actually give us something to reconcile on? */
export function duplicateIsRecoverable(outcome: SubmitOutcome): boolean {
  return outcome.kind === 'duplicate' && outcome.printifyOrderId.length > 0;
}

// ---------------------------------------------------------------------------
// 6. Order payload builder (current API shape)
// ---------------------------------------------------------------------------
const ISO_COUNTRY: Record<string, string> = {
  united_kingdom: 'GB', uk: 'GB', gbr: 'GB', united_kingdom_great_britain: 'GB',
  england: 'GB', scotland: 'GB', wales: 'GB', northern_ireland: 'GB', great_britain: 'GB', britain: 'GB',
  ireland: 'IE', ie: 'IE',
  united_states: 'US', usa: 'US', us: 'US',
  australia: 'AU', au: 'AU',
  germany: 'DE', de: 'DE', france: 'FR', fr: 'FR', spain: 'ES', es: 'ES',
  netherlands: 'NL', nl: 'NL', belgium: 'BE', be: 'BE', canada: 'CA', ca: 'CA',
};

/**
 * Printify wants a 2-letter country code; the checkout stores a full name.
 *
 * The alias table is consulted BEFORE the two-letter shortcut: 'UK' is two
 * letters and looks like a code, but it is not an ISO 3166-1 alpha-2 value —
 * 'GB' is. Passing 'UK' through would be rejected by Printify at submission
 * time, after the claim has already been taken out.
 */
export function isoCountry(country: string): string {
  const raw = (country ?? '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/[\s_.-]+/g, '_');
  if (ISO_COUNTRY[key]) return ISO_COUNTRY[key];
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return '';
}

export type SiteAddress = {
  firstName: string; lastName: string; street: string;
  city: string; postcode: string; country: string; phone: string;
  /** Second line of the address, when the customer supplied one. */
  street2?: string;
  /** County / state. Blank for UK addresses. */
  region?: string;
};

export type OrderLinePayload = {
  external_product_id: string;
  printify_variant_id: number;
  quantity: number;
  line_external_id: string;
};

export type SubmitOrderPayload = {
  external_id: string;
  /** Human-readable label shown in the Printify dashboard. */
  label: string;
  line_items: { product_id: string; variant_id: number; quantity: number; external_id: string }[];
  address_to: {
    first_name: string; last_name: string; address1: string; address2: string;
    city: string; zip: string; country: string; region: string;
    email: string; phone: string;
  };
  shipping_method: number;
  send_shipping_notification: false;
};

/**
 * Printify's shipping method ids, as documented for the order API.
 *
 * The live set available for a destination is returned by
 * `POST /shops/{shop_id}/orders/shipping.json`; these are the documented
 * defaults the store maps onto.
 */
export const PRINTIFY_SHIPPING_METHODS = {
  standard: 1,
  priority: 2,
  express: 3,
  economy: 4,
} as const;

/**
 * Map the store's shipping method onto Printify's.
 *
 * The store sells UK standard and UK express, and Printify names them the
 * same way. Anything unrecognised falls back to standard: a parcel that
 * arrives later is recoverable, a rejected order is not.
 */
export function printifyShippingMethod(storeMethod: string): number {
  const key = (storeMethod ?? '').trim().toLowerCase();
  if (key.includes('express')) return PRINTIFY_SHIPPING_METHODS.express;
  if (key.includes('priority')) return PRINTIFY_SHIPPING_METHODS.priority;
  if (key.includes('economy')) return PRINTIFY_SHIPPING_METHODS.economy;
  return PRINTIFY_SHIPPING_METHODS.standard;
}

/**
 * Build the submission. Only Printify-managed lines are passed in, so a mixed
 * order sends its Printify subset and keeps the rest on the existing order.
 * Throws instead of sending a partial/ambiguous payload — a silent drop here
 * would produce a real order with the wrong items.
 */
export function buildSubmitOrderPayload(input: {
  orderId: string;
  email: string;
  address: SiteAddress;
  lines: OrderLinePayload[];
  /** The store's shipping method, e.g. "UK Standard delivery". */
  shippingMethod?: string;
}): SubmitOrderPayload {
  const country = isoCountry(input.address.country);
  if (!country) {
    throw new Error(`delivery country "${input.address.country}" is not a valid ISO 3166-1 alpha-2 value`);
  }
  const lines = input.lines ?? [];
  if (!lines.length) throw new Error('no Printify-managed lines to submit');

  for (const l of lines) {
    if (!l.external_product_id) throw new Error(`line ${l.line_external_id} has no imported printify product`);
    if (typeof l.printify_variant_id !== 'number') throw new Error(`line ${l.line_external_id} has no mapped variant`);
    if (!(l.quantity > 0)) throw new Error(`line ${l.line_external_id} has a non-positive quantity`);
  }

  return {
    external_id: externalIdFor(input.orderId),
    // Shown in the Printify dashboard so a staff member can match a Printify
    // order to a store order without cross-referencing ids.
    label: input.orderId,
    line_items: lines.map((l) => ({
      product_id: l.external_product_id,
      variant_id: l.printify_variant_id,
      quantity: l.quantity,
      external_id: l.line_external_id,
    })),
    address_to: {
      first_name: input.address.firstName || 'Customer',
      last_name: input.address.lastName || '-',
      address1: input.address.street,
      // Sent as an empty string rather than omitted: Printify documents
      // address2 as a string, and null is not accepted for it.
      address2: input.address.street2 || '',
      city: input.address.city,
      zip: input.address.postcode,
      country,
      // UK addresses carry no state; US/CA/AU ones must, so it is sent
      // explicitly (empty for the UK) rather than left out.
      region: input.address.region || '',
      email: input.email,
      phone: input.address.phone || '',
    },
    shipping_method: printifyShippingMethod(input.shippingMethod ?? ''),
    // The storefront tells the shopper; Printify must not double-email.
    send_shipping_notification: false,
  };
}

// ---------------------------------------------------------------------------
// 7. Status + money display helpers
// ---------------------------------------------------------------------------
/** Printify's documented (lowercase) order statuses. */
export const PRINTIFY_STATUSES = [
  'pending', 'on-hold', 'sending-to-production', 'in-production', 'canceled',
  'fulfilled', 'partially-fulfilled', 'payment-not-received', 'has-issues',
  'cost-calculation', 'unfulfillable',
] as const;

/** Statuses that mean "a human must look at this before it can be produced". */
export const PRINTIFY_BLOCKED_STATUSES = ['has-issues', 'unfulfillable', 'payment-not-received', 'canceled'];

export function printifyStatusMeaning(status: string): string {
  switch (status) {
    case 'pending': return 'Received by Printify, not yet in production.';
    case 'on-hold': return 'Waiting for approval in Printify.';
    case 'sending-to-production': return 'Being sent to the print provider.';
    case 'in-production': return 'Being printed.';
    case 'fulfilled': return 'All lines fulfilled.';
    case 'partially-fulfilled': return 'Some lines fulfilled, some not.';
    case 'canceled': return 'Cancelled in Printify.';
    case 'payment-not-received': return 'Printify could not charge the merchant account.';
    case 'has-issues': return 'Production problem — check inside Printify.';
    case 'unfulfillable': return 'Cannot be fulfilled — check the provider.';
    case 'cost-calculation': return 'Calculating cost.';
    default: return status ? `Status: ${status}` : 'No status received.';
  }
}

/** Provider cost in minor units -> pounds, for display only. */
export function costToPounds(costCents: number): number {
  return Math.max(0, Math.round(costCents)) / 100;
}

/**
 * Margin guard for the import review screen. Returns the margin in pounds
 * between the GBP retail price the site sells at and the provider's production
 * cost — the two numbers must never be confused for each other.
 */
export function marginBetween(retailPounds: number, costCents: number): number {
  return Math.round((retailPounds - costToPounds(costCents)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// 8. Shop discovery and authorization
// ---------------------------------------------------------------------------

/** A shop, as the admin screen needs it. */
export type PrintifyShopSummary = { id: string; title: string; sales_channel: string };

/**
 * Parse the shops list, validating every entry.
 *
 * A shop without a usable id cannot be selected, so it is dropped rather than
 * offered and then failing on the next call. Everything else is passed
 * through, and the sales channel is kept so the admin can see at a glance
 * whether a shop is actually connected to a channel.
 */
export function parseShops(body: unknown): PrintifyShopSummary[] {
  if (!Array.isArray(body)) return [];
  const out: PrintifyShopSummary[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const id = s['id'];
    if (typeof id !== "number" && typeof id !== "string") continue;
    out.push({
      id: String(id),
      title: typeof s['title'] === "string" ? s['title'] : "",
      sales_channel: typeof s['sales_channel'] === "string" ? s['sales_channel'] : "",
    });
  }
  return out;
}

/**
 * Which shop the integration should use.
 *
 * A shop is NEVER guessed. One shop is used; several require an explicit
 * choice; none means the integration cannot work yet. The chosen id is
 * checked against the list the token can actually see, so a stale id in the
 * database is reported rather than used.
 */
export function resolveShopSelection(
  shops: PrintifyShopSummary[],
  chosenId: string,
): { ok: boolean; shop?: PrintifyShopSummary | undefined; error?: string | undefined } {
  if (!shops.length) {
    return {
      ok: false,
      error: "no shop is attached to this token — create one in Printify under My Stores, then connect it to the API sales channel",
    };
  }
  const chosen = chosenId.trim();
  if (!chosen) {
    if (shops.length > 1) {
      return {
        ok: false,
        error: `this token can see ${shops.length} shops — choose the one for HUDA GYMWEAR before continuing`,
      };
    }
    return { ok: true, shop: shops[0] };
  }
  const match = shops.find((s) => s.id === chosen);
  if (!match) {
    return {
      ok: false,
      error: `the saved shop ${chosen} is not visible to this token — it may have been removed, or the token may belong to a different account`,
    };
  }
  return { ok: true, shop: match };
}

/**
 * Whether a signed-in account may drive the integration.
 *
 * The role is read back from the database on every call rather than trusted
 * from the session token, so a demoted staff member loses access at once.
 */
export function isIntegrationAdmin(profile: { role?: string | null } | null | undefined): boolean {
  return profile?.role === "admin";
}