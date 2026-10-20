// scripts/printify-verify.ts
//
// A READ-ONLY verification tool for the Printify API.
//
//   node scripts/printify-verify.ts shops
//   node scripts/printify-verify.ts products <shopId>
//   node scripts/printify-verify.ts product  <shopId> <productId>
//   node scripts/printify-verify.ts webhooks <shopId>
//   node scripts/printify-verify.ts orders   <shopId>
//   node scripts/printify-verify.ts audit
//
// WHAT IT WILL NEVER DO
//   - issue anything other than a GET (a calculation POST is possible only
//     with the explicit --calculate-shipping flag, and it creates nothing);
//   - print, log or echo the API token;
//   - write to the database, create a shop, publish a product, submit an
//     order, or register a webhook.
//
// WHERE THE TOKEN COMES FROM
//   The environment variable PRINTIFY_API_TOKEN, or a `PRINTIFY_API_TOKEN=`
//   line in a local .env.local (gitignored). The token is NEVER read from
//   source code, never written to a file by this script, and never included
//   in the output.
//
// WHY IT EXISTS
//   The integration's API contract can be checked against the live service
//   before anything is deployed, and before fulfilment is switched on.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  printifyFetch,
  printifyErrorMessage,
  redactSecret,
  type PrintifyHttpResult,
} from "../supabase/functions/_shared/printify-http.ts";
import {
  mapVariants,
  variantsWithoutSize,
  productImageUrls,
  type PrintifyProductOption,
  type PrintifyShopProduct,
  type PrintifyVariant,
} from "../supabase/functions/_shared/printify-core.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env["PRINTIFY_API_BASE"] || "https://api.printify.com/v1").replace(/\/+$/, "");

// ---------------------------------------------------------------- credentials
/**
 * Read the token from the environment, or from a gitignored .env.local.
 * It is never written anywhere.
 */
function readToken(): string {
  const fromEnv = (process.env["PRINTIFY_API_TOKEN"] || "").trim();
  if (fromEnv) return fromEnv;
  const local = path.join(ROOT, ".env.local");
  if (existsSync(local)) {
    for (const line of readFileSync(local, "utf8").split(/\r?\n/)) {
      const match = /^PRINTIFY_API_TOKEN\s*=\s*(.+)$/.exec(line.trim());
      if (match?.[1]) return match[1].trim();
    }
  }
  return "";
}

const TOKEN = readToken();
if (!TOKEN) {
  console.error(
    "No Printify API token found.\n" +
      "Set PRINTIFY_API_TOKEN in the environment, or add it to a gitignored .env.local:\n" +
      "  PRINTIFY_API_TOKEN=...\n" +
      "Nothing else is required and the token is never written to a file by this script.",
  );
  process.exit(2);
}

/** Every line printed goes through this, so a token can never be echoed. */
function safe(text: string): string {
  return redactSecret(text, TOKEN);
}

function line(text = ""): void {
  console.log(safe(text));
}

function heading(text: string): void {
  line();
  line(`=== ${text} ${"=".repeat(Math.max(0, 66 - text.length))}`);
}

async function get(path: string): Promise<PrintifyHttpResult> {
  return printifyFetch(`${BASE}${path}`, { token: TOKEN, method: "GET" });
}

function fail(res: PrintifyHttpResult, what: string): never {
  line(`FAILED ${what}: HTTP ${res.status} — ${res.error}`);
  if (res.status === 401 || res.status === 403) {
    line();
    line("  The token was rejected by Printify. In order of likelihood:");
    line("   1. The token was REVOKED, or a newer token was generated for the same");
    line("      connection and invalidated it. Generate a fresh one in");
    line("      Printify -> My Profile -> Connections -> Personal Access Tokens.");
    line("   2. The token belongs to a different Printify account than the one that");
    line("      owns the shop. The `aud` claim is the account it was issued for.");
    line("   3. The token is a Platform/OAuth token rather than a Personal Access");
    line("      Token. The shop endpoints are PAT-only.");
    line();
    line("  A Personal Access Token is valid for one year. If it was issued less");
    line("  than a year ago and still fails, it has been revoked.");
    line();
    line("  NOTE: the request itself is correct. The same call with the documented");
    line("  `Authorization: Bearer <token>` header and the required User-Agent");
    line("  returns this same 401, and the body carries a Printify request_id.");
  }
  if (res.status === 404) line("  The endpoint or id does not exist for this token.");
  if (res.status === 429) {
    line("  Rate limited. Printify allows 600 requests a minute; wait and retry.");
    line("  Error responses are capped at 5% of total requests, so do not retry in a loop.");
  }
  process.exit(1);
}

// ------------------------------------------------------------------ shapes
type Shop = { id: string; title: string; sales_channel: string };

function parseShops(body: unknown): Shop[] {
  if (!Array.isArray(body)) return [];
  const out: Shop[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const id = s["id"];
    if (typeof id !== "number" && typeof id !== "string") continue;
    out.push({
      id: String(id),
      title: typeof s["title"] === "string" ? s["title"] : "",
      sales_channel: typeof s["sales_channel"] === "string" ? s["sales_channel"] : "",
    });
  }
  return out;
}

function parseProducts(body: unknown): PrintifyShopProduct[] {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const list = Array.isArray(b["data"]) ? b["data"] : Array.isArray(body) ? body : [];
  return (list as PrintifyShopProduct[]).filter((p) => p && typeof p.id === "string");
}

// ----------------------------------------------------------------- commands
async function cmdShops(): Promise<void> {
  heading("SHOPS  GET /v1/shops.json");
  const res = await get("/shops.json");
  if (!res.ok) fail(res, "shops");
  const shops = parseShops(res.body);
  line(`Token accepted. ${shops.length} shop(s) visible:`);
  for (const s of shops) {
    line(`  id ${s.id.padEnd(12)} ${s["title"]}${s["sales_channel"] ? `   [sales channel: ${s["sales_channel"]}]` : ""}`);
  }
  if (shops.length === 0) {
    line("  No shops are attached to this token. Create one in Printify:");
    line("  My Stores -> Add a new store -> API -> Connect.");
  }
  if (shops.length > 1) {
    line();
    line("  More than one shop is visible. Select the right one explicitly in");
    line("  Brand Studio -> Printify; nothing is selected automatically.");
  }
}

async function cmdProducts(shopId: string): Promise<void> {
  heading(`PRODUCTS  GET /v1/shops/${shopId}/products.json`);
  const products: PrintifyShopProduct[] = [];
  let page = 1;
  let guard = 0;
  for (;;) {
    const res = await get(`/shops/${shopId}/products.json?page=${page}&limit=50`);
    if (!res.ok) fail(res, `products page ${page}`);
    const batch = parseProducts(res.body);
    products.push(...batch);
    const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
    line(`  page ${page}: ${batch.length} product(s)`);
    guard++;
    if (!batch.length || guard > 40) break;
    if (typeof b["next_page_url"] !== "string" || !b["next_page_url"]) break;
    page = Number(b["current_page"] || page) + 1;
  }
  line(`  total: ${products.length}`);
  for (const p of products) {
    line(`    ${p.id}  ${p.title ?? "(untitled)"}  variants=${(p.variants ?? []).length} visible=${p.visible !== false}`);
  }
}

async function cmdProduct(shopId: string, productId: string): Promise<void> {
  heading(`PRODUCT  GET /v1/shops/${shopId}/products/${productId}.json`);
  const res = await get(`/shops/${shopId}/products/${productId}.json`);
  if (!res.ok) fail(res, "product");
  const p = res.body as PrintifyShopProduct;
  line(`  id            ${p.id}`);
  line(`  title         ${p.title ?? ""}`);
  line(`  description   ${(p.description ?? "").slice(0, 160)}`);
  line(`  blueprint_id  ${p.blueprint_id ?? "-"}`);
  line(`  provider_id   ${p.print_provider_id ?? "-"}`);
  line(`  visible       ${p.visible}`);
  line(`  locked        ${p.is_locked}`);
  const images = productImageUrls(p.images);
  line(`  images        ${images.length}`);
  for (const src of images.slice(0, 4)) line(`                 ${src}`);
  const options = p.options ?? [];
  line(`  product options (the axis definitions the variant ids refer to):`);
  for (const o of options) {
    line(`    ${o.name ?? ""} (type=${o.type ?? "-"})`);
    for (const v of o.values ?? []) line(`      id ${v.id}  "${v.title ?? ""}"`);
  }
  const variants = p.variants ?? [];
  line(`  variants (${variants.length}):`);
  for (const v of variants) {
    line(
      `    id ${v.id}  sku=${v.sku ?? "-"}  cost=${v.cost ?? "-"}  enabled=${v.is_enabled !== false}  available=${v.is_available !== false}  optionIds=${JSON.stringify(v.options ?? [])}`,
    );
  }
  // The mapping readiness check: can each variant be resolved to a size?
  const unresolvable = variantsWithoutSize(variants as PrintifyVariant[], options as PrintifyProductOption[]);
  line();
  if (unresolvable.length === 0) {
    line("  Every variant resolves to a size axis.");
  } else {
    line(`  ${unresolvable.length} variant(s) do NOT resolve to a size axis:`);
    for (const u of unresolvable) line(`    id ${u.variant_id}  ${u.reason}`);
  }
}

async function cmdWebhooks(shopId: string): Promise<void> {
  heading(`WEBHOOKS  GET /v1/shops/${shopId}/webhooks.json`);
  const res = await get(`/shops/${shopId}/webhooks.json`);
  if (!res.ok) fail(res, "webhooks");
  const list = Array.isArray(res.body) ? res.body : [];
  line(`  ${list.length} webhook(s) registered (this call only READS; nothing is changed):`);
  for (const w of list as { id?: string; topic?: string; url?: string }[]) {
    line(`    id ${w["id"] ?? "-"}  topic=${w["topic"] ?? "-"}`);
    line(`       url=${w["url"] ?? "-"}`);
  }
  if (list.length === 0) {
    line("  No webhook is registered. Tracking can still be reconciled by re-reading an order.");
  }
}

async function cmdOrders(shopId: string): Promise<void> {
  heading(`ORDERS  GET /v1/shops/${shopId}/orders.json  (read only)`);
  const res = await get(`/shops/${shopId}/orders.json?page=1&limit=10`);
  if (!res.ok) fail(res, "orders");
  const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
  const list = Array.isArray(b["data"]) ? b["data"] : [];
  line(`  ${list.length} order(s) on the first page (max page size is 10).`);
  for (const o of list as { id?: string; status?: string; external_id?: string; total_price?: number; created_at?: string }[]) {
    line(`    id ${o["id"] ?? "-"}  status=${o["status"] ?? "-"}  external_id=${o["external_id"] ?? "-"}  total=${o["total_price"] ?? "-"}  created=${o["created_at"] ?? "-"}`);
  }
  line();
  line("  This listing is read-only. No order is created, cancelled or modified.");
}

/**
 * The read-only sweep, plus the mapping readiness of every product.
 */
async function cmdAudit(): Promise<void> {
  heading("SHOPS");
  const shopsRes = await get("/shops.json");
  if (!shopsRes.ok) fail(shopsRes, "shops");
  const shops = parseShops(shopsRes.body);
  for (const s of shops) {
    line(`  id ${s.id.padEnd(12)} ${s["title"]}${s["sales_channel"] ? `   [${s["sales_channel"]}]` : ""}`);
  }
  if (shops.length === 0) {
    line("  No shop is attached to this token.");
    return;
  }
  if (shops.length > 1) {
    line();
    line("  Several shops are visible. The audit below covers the FIRST one only.");
    line("  Select the intended shop in Brand Studio -> Printify before relying on any of this.");
  }
  const shop = shops[0]!;

  heading(`CATALOGUE  GET /v1/shops/${shop.id}/products.json`);
  const products: PrintifyShopProduct[] = [];
  let page = 1;
  for (;;) {
    const res = await get(`/shops/${shop.id}/products.json?page=${page}&limit=50`);
    if (!res.ok) fail(res, `products page ${page}`);
    const batch = parseProducts(res.body);
    products.push(...batch);
    const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
    if (!batch.length || typeof b["next_page_url"] !== "string" || !b["next_page_url"]) break;
    page = Number(b["current_page"] || page) + 1;
    if (page > 40) break;
  }
  line(`  ${products.length} product(s) in shop ${shop.id}`);

  const totals = { variants: 0, resolvable: 0, unresolvable: 0, unavailable: 0, images: 0, withCost: 0 };
  for (const p of products) {
    const options = (p.options ?? []) as PrintifyProductOption[];
    const variants = (p.variants ?? []) as PrintifyVariant[];
    const bad = variantsWithoutSize(variants, options);
    const images = productImageUrls(p.images);
    const withCost = variants.filter((v) => typeof v.cost === "number").length;
    const unavailable = variants.filter((v) => v.is_available === false).length;
    totals.variants += variants.length;
    totals.unresolvable += bad.length;
    totals.resolvable += variants.length - bad.length;
    totals.unavailable += unavailable;
    totals.images += images.length;
    totals.withCost += withCost;
    line();
    line(`  ${p.id}  ${p.title ?? "(untitled)"}`);
    line(`    blueprint=${p.blueprint_id ?? "-"} provider=${p.print_provider_id ?? "-"} visible=${p.visible !== false} locked=${p.is_locked === true}`);
    line(`    variants=${variants.length}  resolvable=${variants.length - bad.length}  unresolvable=${bad.length}  unavailable=${unavailable}`);
    line(`    mockups=${images.length}  variants-with-cost=${withCost}`);
    const axes = new Map<string, Set<string>>();
    for (const o of options) {
      for (const v of o.values ?? []) {
        const key = (o.type || o.name || "option").toLowerCase();
        if (!axes.has(key)) axes.set(key, new Set());
        axes.get(key)!.add(String(v.title ?? ""));
      }
    }
    for (const [axis, values] of axes) line(`    ${axis}: ${[...values].join(", ")}`);
    if (bad.length) {
      for (const u of bad.slice(0, 5)) line(`    UNMAPPABLE id ${u.variant_id}: ${u.reason}`);
    }
    // The site's own colour list is not known here (it lives in the database),
    // so the colour match cannot be evaluated offline. Report the labels.
    const mapped = mapVariants(variants, options, []);
    line(`    mapped with an empty site colour list: ${mapped.supported.length}`);
  }

  heading("TOTALS");
  line(`  products            ${products.length}`);
  line(`  variants            ${totals.variants}`);
  line(`  size-resolvable     ${totals.resolvable}`);
  line(`  NOT size-resolvable ${totals.unresolvable}`);
  line(`  unavailable         ${totals.unavailable}`);
  line(`  mockup images       ${totals.images}`);
  line(`  variants with cost  ${totals.withCost}`);
  line();
  line("  A variant that is not size-resolvable can never be mapped to a");
  line("  storefront size, and would land in the admin's review list.");
}

// --------------------------------------------------------------------- entry
const [command, ...rest] = process.argv.slice(2);
const wantsShipping = process.argv.includes("--calculate-shipping");

try {
  switch (command) {
    case "shops":
      await cmdShops();
      break;
    case "products":
      if (!rest[0]) throw new Error("usage: products <shopId>");
      await cmdProducts(rest[0]);
      break;
    case "product":
      if (!rest[0] || !rest[1]) throw new Error("usage: product <shopId> <productId>");
      await cmdProduct(rest[0], rest[1]);
      break;
    case "webhooks":
      if (!rest[0]) throw new Error("usage: webhooks <shopId>");
      await cmdWebhooks(rest[0]);
      break;
    case "orders":
      if (!rest[0]) throw new Error("usage: orders <shopId>");
      await cmdOrders(rest[0]);
      break;
    case "audit":
      await cmdAudit();
      break;
    case "shipping": {
      if (!rest[0]) throw new Error("usage: shipping <shopId> <country> <postal>");
      if (!wantsShipping) {
        line(
          "This command POSTs to /orders/shipping.json, which CALCULATES a price and creates nothing.\n" +
            "It is off by default. Re-run with --calculate-shipping to allow it.",
        );
        process.exit(0);
      }
      const res = await printifyFetch(`${BASE}/shops/${rest[0]}/orders/shipping.json`, {
        token: TOKEN,
        method: "POST",
        body: {
          address_to: { country: rest[1] ?? "GB", zip: rest[2] ?? "", city: rest[3] ?? "", address1: "" },
          line_items: [],
        },
      });
      heading(`SHIPPING RATES  POST /v1/shops/${rest[0]}/orders/shipping.json`);
      line(`  HTTP ${res.status} ${res.ok ? "(ok)" : `(failed: ${res.error})`}`);
      line(`  ${safe(JSON.stringify(res.body))}`);
      break;
    }
    default:
      line("usage:");
      line("  node scripts/printify-verify.ts shops");
      line("  node scripts/printify-verify.ts products <shopId>");
      line("  node scripts/printify-verify.ts product  <shopId> <productId>");
      line("  node scripts/printify-verify.ts webhooks <shopId>");
      line("  node scripts/printify-verify.ts orders   <shopId>");
      line("  node scripts/printify-verify.ts audit");
      line("  node scripts/printify-verify.ts shipping <shopId> <country> <postal> --calculate-shipping");
      line();
      line("Every command is read-only. The token is never printed.");
      process.exit(command ? 2 : 0);
  }
} catch (err) {
  console.error(safe(err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
