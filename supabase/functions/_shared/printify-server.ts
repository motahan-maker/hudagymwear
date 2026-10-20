// supabase/functions/_shared/printify-server.ts
//
// Server-only half of the Printify integration: HTTP + database writes.
// Imported by BOTH Edge Functions (the admin broker and the webhook receiver)
// so the catalog mirror and the variant-map rules exist once and cannot drift
// apart — a webhook that rebuilt mappings differently from an admin sync would
// silently change what gets produced.
//
// Nothing here is browser-safe and nothing here is imported by src/.

// deno-lint-ignore-file no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2";
import { mapVariants, normalizeSize, productImageUrls, type PrintifyProductImage, type PrintifyProductOption, type PrintifyShopProduct, type PrintifyVariant } from "./printify-core.ts";
// The single HTTP implementation. It is Deno-free so the local verification
// script and the vitest suite can use the exact same code.
import { printifyFetch, type PrintifyHttpResult } from "./printify-http.ts";

const PFY_BASE = Deno.env.get("PRINTIFY_API_BASE") || "https://api.printify.com/v1";
// Printify requires a descriptive User-Agent on every request.
const USER_AGENT = "HUDAGYMWEAR-BrandStudio/1.0 (+https://hudagymwear.co.uk)";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

/** The Supabase client, whichever key it was created with. */
type Db = ReturnType<typeof createClient>;
export type { Db };

export type PfyResult = { status: number; body: unknown; retryAfterSeconds?: number };

/**
 * One Printify API call.
 *
 * A thin adapter over the shared, Deno-free HTTP module: same timeout, same
 * bounded retry, same `Retry-After` handling, same redaction — in the Edge
 * Function and in the local script alike.
 */
export async function pfy(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<PfyResult> {
  const res: PrintifyHttpResult = await printifyFetch(`${PFY_BASE}${path}`, {
    token,
    method: (init.method as "GET" | "POST" | undefined) ?? "GET",
    body: init.body,
    userAgent: USER_AGENT,
  });
  return {
    status: res.status,
    body: res.body,
    ...(res.retryAfterSeconds ? { retryAfterSeconds: res.retryAfterSeconds } : {}),
  };
}

/**
 * Printify's error envelope.
 *
 * Three shapes are in use and all three have been seen from the live API:
 *   `{ errors: [{ message }] }`  - validation failures
 *   `{ message }`                - most other failures
 *   `{ error }`                  - e.g. `{ "error": "Unauthenticated" }` for a
 *                                  rejected token, which has NO message field
 *                                  and would otherwise show as a bare
 *                                  "HTTP 401" to the store owner.
 */
export function pfyError(body: unknown, status: number): string {
  const b = obj(body);
  const first = arr<{ message?: string }>(b.errors)[0];
  return (
    first?.message ||
    str(b.message) ||
    str(b.error) ||
    `Printify returned HTTP ${status}`
  );
}

export async function loadCredentials(db: Db): Promise<{ token: string; webhookSecret: string }> {
  const { data } = await db.from("printify_credentials")
    .select("api_token, webhook_secret").eq("id", 1).maybeSingle();
  return { token: str(data?.api_token), webhookSecret: str(data?.webhook_secret) };
}

export async function loadSettings(db: Db): Promise<Record<string, unknown>> {
  const { data } = await db.from("printify_settings").select("*").eq("id", 1).maybeSingle();
  return obj(data);
}

/**
 * Pull the shop's products into printify_products.
 *
 * Idempotent by construction: the upsert names ONLY provider-owned fields, so a
 * retried or out-of-order sync cannot blank the website's category, visibility,
 * retail price or merchandising decisions. Those live in `products`, and
 * `product_id` / `status` / `first_seen_at` are deliberately not written here.
 */
export async function upsertPrintifyProducts(
  db: Db,
  shopId: string,
  items: PrintifyShopProduct[],
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0, updated = 0, skipped = 0;
  for (const p of items) {
    if (!str(p.id)) { skipped++; continue; }
    const variants = arr<PrintifyVariant>(p.variants);
    const images = arr<PrintifyProductImage>(p.images);
    const options = arr<PrintifyProductOption>(p.options);
    const cheapest = variants.reduce(
      (min, v) => (typeof v.cost === "number" && (min < 0 || v.cost < min) ? v.cost : min), -1,
    );
    const before = await db.from("printify_products").select("external_product_id")
      .eq("external_product_id", p.id).maybeSingle();
    const { error } = await db.from("printify_products").upsert({
      external_product_id: p.id,
      shop_id: shopId,
      blueprint_id: Number(p.blueprint_id) || 0,
      print_provider_id: Number(p.print_provider_id) || 0,
      title: str(p.title),
      description: p.description ?? null,
      // The raw mockup objects, plus a flat list of their URLs. `images` is a
      // list of OBJECTS in the API, not a list of URL strings.
      images,
      image_urls: productImageUrls(images),
      // The option definitions the variant ids refer to. Without these the
      // variant mapper cannot tell which axis an option belongs to, and every
      // variant would be reported as unmapped.
      options,
      variants,
      // Provider production cost in minor units — never a sell price.
      cost_cents: cheapest < 0 ? 0 : Math.max(0, Math.round(cheapest)),
      available: variants.some((v) => v.is_available !== false),
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "external_product_id" });
    if (error) throw new Error(`catalog write failed: ${error.message}`);
    if (before.data) updated++; else created++;
  }
  return { created, updated, skipped };
}

/** Fetch one shop product and mirror it. Used by product webhooks and publish. */
export async function syncOneProduct(db: Db, token: string, shopId: string, externalId: string) {
  const r = await pfy(token, `/shops/${shopId}/products/${externalId}.json`);
  if (r.status !== 200) return { ok: false, error: pfyError(r.body, r.status) };
  await upsertPrintifyProducts(db, shopId, [obj(r.body) as PrintifyShopProduct]);
  return { ok: true };
}

/**
 * Rebuild the trusted (size, colour) -> Printify variant map for one product.
 *
 * A combination that cannot be expressed in the site's colour/size model gets
 * NO map row. Since claim_printify_fulfilment() joins on that map, an unmapped
 * combination can never be produced on a guessed variant id — it simply stays
 * on the order for manual handling, which is the whole point of importing into
 * a pending-review state rather than straight to the storefront.
 */
export async function rebuildVariantMap(db: Db, externalId: string): Promise<{
  mapped: number; unsupported: { variant_id: number; reason: string }[]; reason: string;
}> {
  const { data: pp } = await db.from("printify_products")
    .select("external_product_id, variants, options, product_id").eq("external_product_id", externalId).maybeSingle();
  if (!pp?.product_id) {
    return { mapped: 0, unsupported: [], reason: "not linked to a storefront product" };
  }

  const { data: site } = await db.from("products").select("colours, colour").eq("id", pp.product_id).maybeSingle();
  const siteColours: string[] = arr<{ name?: string }>(site?.colours).map((c) => str(c?.name)).filter(Boolean);
  if (!siteColours.length && str(site?.colour)) siteColours.push(str(site?.colour));

  // The variant ids are resolved against the product's option definitions.
  const result = mapVariants(
    arr<PrintifyVariant>(pp.variants),
    arr<PrintifyProductOption>(pp.options),
    siteColours,
  );

  // A mapping an admin has reviewed and set by hand is a decision, not a
  // derived value. A re-sync must not quietly replace it with whatever the
  // automatic mapper now believes.
  const { data: manualRows } = await db.from("printify_variant_map")
    .select("size, colour, printify_variant_id, sku, cost_cents, available")
    .eq("external_product_id", externalId).eq("source", "manual");
  const manual = arr<Record<string, unknown>>(manualRows);
  const manualKeys = new Set(manual.map((r) => `${str(r.size)}|${str(r.colour)}`));

  const autoRows = result.supported
    .filter((r) => !manualKeys.has(`${r.size}|${r.colour}`))
    .map((r) => ({
      external_product_id: externalId,
      size: normalizeSize(r.size),
      colour: r.colour,
      printify_variant_id: r.printify_variant_id,
      sku: r.sku,
      cost_cents: r.cost_cents,
      available: r.available,
      source: "auto",
      updated_at: new Date().toISOString(),
    }));

  if (!autoRows.length && !manual.length) {
    // Wipe the map: an unmapped product must offer nothing to fulfilment.
    await db.from("printify_variant_map").delete().eq("external_product_id", externalId);
    await db.from("printify_products")
      .update({ status: "unsupported", updated_at: new Date().toISOString() })
      .eq("external_product_id", externalId);
    return { mapped: 0, unsupported: result.unsupported, reason: "no Printify variant fits the site model" };
  }

  // Only the automatic rows are replaced; reviewed rows stay untouched.
  await db.from("printify_variant_map").delete()
    .eq("external_product_id", externalId).neq("source", "manual");
  const rows = [
    ...autoRows,
    ...manual.map((r) => ({
      external_product_id: externalId,
      size: normalizeSize(str(r.size)),
      colour: str(r.colour),
      printify_variant_id: Number(r.printify_variant_id),
      sku: str(r.sku),
      cost_cents: Number(r.cost_cents) || 0,
      available: r.available !== false,
      source: "manual",
      updated_at: new Date().toISOString(),
    })),
  ];
  const { error } = await db.from("printify_variant_map").upsert(rows, { onConflict: "external_product_id,size,colour" });
  if (error) throw new Error(`variant map write failed: ${error.message}`);

  await db.from("printify_products")
    .update({ status: "imported", updated_at: new Date().toISOString() })
    .eq("external_product_id", externalId);
  return { mapped: rows.length, unsupported: result.unsupported, reason: "" };
}

/** Our order id for a Printify order id, via the stored submission record. */
export async function orderIdForPrintifyOrder(db: Db, printifyOrderId: string): Promise<string> {
  if (!printifyOrderId) return "";
  const { data } = await db.from("order_fulfilment")
    .select("order_id").eq("printify_order_id", printifyOrderId).maybeSingle();
  return str(data?.order_id);
}
