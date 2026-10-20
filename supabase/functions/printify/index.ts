// supabase/functions/printify — the trusted half of the Printify integration
//
// WHY THIS EXISTS AT ALL
//   This app is otherwise fully client-side: `src/lib/supabase.ts` ships the
//   anon key, and every VITE_ variable ends up inside the public JS bundle.
//   A Printify Personal Access Token therefore cannot live anywhere the browser
//   can reach — it is a bearer credential that can create real production orders
//   charged to the merchant payment method. Everything that touches Printify
//   runs here, and this function never returns the token to a caller.
//
// AUTH IS NOT THE ADMIN GUARD
//   <AdminGuard> in src/components/admin.tsx decides what to RENDER. It is not a
//   security boundary and nothing here trusts it. Every request is verified in
//   three independent steps:
//     1. the bearer JWT is validated against Supabase Auth (getUser),
//     2. profiles.role = 'admin' is read back through RLS on the CALLER'S OWN
//        token — a non-admin gets zero rows,
//     3. privileged RPCs (claim / release / COD policy) are executed through
//        that same caller-scoped client, so public.is_admin() and table RLS
//        apply again inside Postgres.
//   The service-role client is used only for reads/writes the caller has already
//   been authorised for (credentials, catalog mirror, sync log). It is never
//   handed a request the caller could not make.
//
// ENV (Dashboard → Settings → Edge Functions → Secrets)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY  (injected)
//   PRINTIFY_API_BASE      optional, default https://api.printify.com/v1
//   SITE_URL               https://hudagymwear.vercel.app (webhook URL building)
//   Nothing Printify-related goes in VITE_.
//
// SETUP + VERIFICATION: see supabase/PRINTIFY_SETUP.md

// deno-lint-ignore-file no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  costToPounds,
  interpretSubmitResponse,
  lineExternalId,
  printifyStatusMeaning,
  marginBetween,
  buildSubmitOrderPayload,
  paymentGate,
  variantsWithoutSize,
  isIntegrationAdmin,
  parseShops,
  resolveShopSelection,
  GATE_MESSAGE,
  PRINTIFY_TOPICS,
  sha256Hex,
  uuidFromDigest,
  type PrintifyShopProduct,
} from "../_shared/printify-core.ts";
// The HTTP client, credential reads and catalog mirror live in _shared so the
// admin broker and the webhook receiver cannot drift apart.
import {
  loadCredentials,
  loadSettings,
  pfy,
  pfyError,
  rebuildVariantMap,
  upsertPrintifyProducts,
} from "../_shared/printify-server.ts";

const PFY_BASE = Deno.env.get("PRINTIFY_API_BASE") || "https://api.printify.com/v1";
const SITE_URL = (Deno.env.get("SITE_URL") || "").replace(/\/+$/, "");

const CORS: Record<string, string> = {
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-api-key",
  "access-control-max-age": "600",
};

const json = (status: number, body: unknown, origin = "") =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...CORS,
      ...(origin ? { "access-control-allow-origin": origin } : {}),
    },
  });

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

// ---------------------------------------------------------------------------
// Caller verification
// ---------------------------------------------------------------------------
type Admin = {
  id: string;
  /** Client scoped to the CALLER's JWT: RLS + is_admin() apply to everything. */
  asUser: ReturnType<typeof createClient>;
};

async function authenticate(req: Request): Promise<{ admin?: Admin; error?: string }> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { error: "missing session" };

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return { error: "integration is not configured on this project" };

  // Step 1: does Auth accept this JWT right now? (signature, expiry, revocation)
  const probe = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { authorization: `Bearer ${token}` } },
  });
  const { data, error } = await probe.auth.getUser();
  if (error || !data?.user) return { error: "session is not valid" };

  // Step 2: is this user an admin? Read back through RLS, not from the JWT —
  // a stale token must not keep a demoted staff member in.
  const { data: profile, error: perr } = await probe
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (perr) return { error: "could not verify the account" };
  if (!isIntegrationAdmin(profile)) return { error: "this account is not an administrator" };

  // Step 3: keep the caller-scoped client so every RPC/insert below inherits
  // the same RLS + is_admin() checks inside Postgres.
  return { admin: { id: data.user.id, asUser: probe } };
}

/** Service-role client for the rows a browser must never touch directly. */
function service() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function actTestConnection(admin: Admin, db: ReturnType<typeof createClient>) {
  const { token } = await loadCredentials(db);
  if (!token) return json(400, { ok: false, error: "save an API token first" });
  const r = await pfy(token, "/shops.json");
  const shops = r.status === 200 ? parseShops(r.body) : [];
  await db.from("printify_settings").update({
    last_test_at: new Date().toISOString(),
    last_test_ok: r.status === 200,
    last_error: r.status === 200 ? null : pfyError(r.body, r.status).slice(0, 400),
    // Remember the shops so the admin can choose between them without
    // pressing TEST CONNECTION again. A failed test clears the list: a stale
    // shop list is worse than none.
    last_shops: r.status === 200 ? shops : [],
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
  if (r.status !== 200) {
    // A rejected token is the most common failure and the least informative
    // one, so it gets its own safe diagnostic. The token itself is never
    // included — only the status and the message Printify returned.
    const detail = pfyError(r.body, r.status);
    const hint =
      r.status === 401 || r.status === 403
        ? "Printify rejected the token. It may have been revoked, it may belong to a different account, or it may not be a Personal Access Token. Tokens are valid for one year."
        : r.status === 429
          ? "Printify is rate limiting this account. Wait a minute and try again — repeated failures count against a 5% error-rate limit."
          : detail;
    return json(502, { ok: false, error: hint, status: r.status, detail });
  }
  return json(200, {
    ok: true,
    shops,
  });
}

/** Printify's own docs warn that publishing only notifies us; we do the work,
 *  then MUST report success or failure back or the product stays locked. */
async function actSync(admin: Admin, db: ReturnType<typeof createClient>) {
  const settings = await loadSettings(db);
  const { token } = await loadCredentials(db);
  const shopId = str(settings.shop_id);
  if (!token) return json(400, { ok: false, error: "save an API token first" });
  if (!shopId) return json(400, { ok: false, error: "select a shop first" });

  const run = await db.from("printify_sync_runs").insert({ kind: "products" }).select("id").single();
  const runId = run.data?.id;

  const fetched: PrintifyShopProduct[] = [];
  let page = 1, guard = 0;
  for (;;) {
    const r = await pfy(token, `/shops/${shopId}/products.json?page=${page}&limit=50`);
    if (r.status !== 200) {
      await db.from("printify_sync_runs").update({ status: "failed", error: pfyError(r.body, r.status), finished_at: new Date().toISOString() }).eq("id", runId);
      return json(502, { ok: false, error: pfyError(r.body, r.status) });
    }
    const envelope = obj(r.body);
    const batch = arr<PrintifyShopProduct>(envelope.data ?? r.body);
    fetched.push(...batch);
    guard++;
    // Pagination is Laravel-shaped; stop on an empty page or a hard safety cap.
    if (!batch.length || guard > 40) break;
    if (!str(envelope.next_page_url)) break;
    page = Number(envelope.current_page || page) + 1;
  }

  const counts = await upsertPrintifyProducts(db, shopId, fetched);

  // Anything that vanished from the shop is marked archived, never deleted:
  // fulfilment history must keep pointing at something.
  const seen = fetched.map((p) => str(p.id)).filter(Boolean);
  let archived = 0;
  if (seen.length) {
    const { data: gone } = await db.from("printify_products").select("external_product_id")
      .eq("shop_id", shopId).neq("status", "archived");
    const stale = arr<{ external_product_id: string }>(gone).filter((g) => !seen.includes(g.external_product_id));
    if (stale.length) {
      await db.from("printify_products").update({ status: "archived", updated_at: new Date().toISOString() })
        .in("external_product_id", stale.map((s) => s.external_product_id));
      archived = stale.length;
    }
  }

  // Refresh maps for already-linked products so cost/availability follow Printify.
  const linked = arr<{ external_product_id: string }>(
    (await db.from("printify_products").select("external_product_id").eq("shop_id", shopId).eq("status", "imported")).data,
  );
  let unsupported = 0;
  for (const l of linked) {
    const m = await rebuildVariantMap(db, l.external_product_id);
    if (m.unsupported.length) unsupported++;
  }

  await db.from("printify_products").update({ last_synced_at: new Date().toISOString() })
    .in("external_product_id", seen.length ? seen : ["__none__"]);
  await db.from("printify_settings").update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", 1);
  await db.from("printify_sync_runs").update({
    status: "ok", fetched: fetched.length, created: counts.created, updated: counts.updated,
    unchanged: 0, unsupported, archived, finished_at: new Date().toISOString(),
  }).eq("id", runId);

  return json(200, { ok: true, fetched: fetched.length, created: counts.created, updated: counts.updated, archived, unsupported });
}

/**
 * Create the storefront draft for a synced Printify product.
 *  - stable id derived from the Printify product id, so a re-import of the same
 *    product resolves to the same row instead of a duplicate,
 *  - status 'Draft', so it is invisible to shoppers until an admin approves it
 *    through the existing products dashboard,
 *  - retail price comes ONLY from the admin. The provider cost is stored
 *    separately in cost_cents and is never used as a price.
 */
async function actImport(admin: Admin, db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const externalId = str(body.external_product_id);
  const category = str(body.category);
  const name = str(body.name);
  const retailPrice = Number(body.retail_price);
  if (!externalId) return json(400, { ok: false, error: "external_product_id is required" });
  if (!name) return json(400, { ok: false, error: "a product name is required" });
  if (!category) return json(400, { ok: false, error: "assign a storefront category" });
  if (!(retailPrice > 0)) return json(400, { ok: false, error: "enter the GBP retail price yourself — production cost is not a price" });

  const { data: pp } = await db.from("printify_products")
    .select("external_product_id, title, description, images, variants, cost_cents, status, product_id")
    .eq("external_product_id", externalId).maybeSingle();
  if (!pp) return json(404, { ok: false, error: "run a sync first — that product is not imported" });

  const colours = arr<{ name?: string; tone?: string }>(body.colours).map((c) => str(c?.name)).filter(Boolean);
  const productId = `pfy-${externalId}`;

  const images = arr(pp.images).map(str).filter(Boolean);
  const { error: perr } = await db.from("products").upsert({
    id: productId,
    name,
    category,
    colour: colours[0] ?? "Onyx Black",
    tone: str(obj(body).tone) || "onyx",
    price: retailPrice,
    description: str(pp.description) || null,
    image: images[0] ?? "",
    images,
    colours: arr<{ name?: string; tone?: string }>(body.colours),
    // Hidden until the admin publishes it from the products dashboard.
    status: "Draft",
    sku: `PFY-${externalId}`,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  if (perr) return json(500, { ok: false, error: `could not create the draft: ${perr.message}` });

  await db.from("printify_products").update({ product_id: productId, updated_at: new Date().toISOString() })
    .eq("external_product_id", externalId);
  const map = await rebuildVariantMap(db, externalId);

  return json(200, {
    ok: true,
    product_id: productId,
    mapped: map.mapped,
    unsupported: map.unsupported,
    reason: map.reason,
    // Show the margin; do not act on it.
    cost_pounds: costToPounds(Number(pp.cost_cents)),
    margin_pounds: marginBetween(retailPrice, Number(pp.cost_cents)),
  });
}

/**
 * Release the fulfilment claim and report whether it actually took effect.
 *
 * The release is refused when the claim token no longer matches — the claim
 * expired and somebody else took it. The order may already have been sent to
 * Printify, so a refused release must never be reported as a clean success.
 */
async function releaseClaim(
  admin: Admin,
  orderId: string,
  claimToken: string,
  succeeded: boolean,
  printifyOrderId: string | null,
  error: string | null,
): Promise<{ ok: boolean; error: string }> {
  const { data, error: rpcError } = await admin.asUser.rpc("release_printify_fulfilment", {
    p_order_id: orderId, p_claim_token: claimToken, p_succeeded: succeeded,
    p_printify_order_id: printifyOrderId, p_error: error,
  });
  if (rpcError) return { ok: false, error: rpcError.message };
  const res = obj(data);
  if (res.ok === false) {
    return { ok: false, error: str(res.error) || "the claim could not be released" };
  }
  return { ok: true, error: "" };
}

async function actFulfil(admin: Admin, db: ReturnType<typeof createClient>, body: Record<string, unknown>, isRetry: boolean) {
  const orderId = str(body.order_id);
  if (!orderId) return json(400, { ok: false, error: "order_id is required" });

  // The claim itself runs as the caller, so Postgres re-checks is_admin(), the
  // payment gate, the COD policy, and takes the row lock that stops two
  // submissions racing.
  const { data: claimed, error: claimErr } = await admin.asUser
    .rpc("claim_printify_fulfilment", { p_order_id: orderId });
  if (claimErr) return json(500, { ok: false, error: claimErr.message });
  const claim = obj(claimed);
  if (claim.ok !== true) {
    return json(409, {
      ok: false,
      error: str(claim.error),
      state: str(claim.state),
      printify_order_id: str(claim.printify_order_id),
      retriable: isRetry && str(claim.state) === "failed",
    });
  }

  const token = (await loadCredentials(db)).token;
  const shopId = str(claim.shop_id);
  const lines = arr<Record<string, unknown>>(claim.lines);

  // `items` is read only to report how many lines were deliberately held back;
  // the payload itself is built exclusively from the claimed Printify lines.
  const { data: order } = await admin.asUser.from("orders")
    .select("id, guest_email, address, status, items, shipping").eq("id", orderId).maybeSingle();
  if (!order) {
    await releaseClaim(admin, orderId, str(claim.claim_token), false, null, "order row could not be read");
    return json(500, { ok: false, error: "order row could not be read" });
  }

  let payload;
  try {
    payload = buildSubmitOrderPayload({
      orderId,
      email: str(order.guest_email),
      address: obj(order.address) as never,
      // The store's own shipping choice decides Printify's shipping method, so
      // a customer who paid for express is not sent standard.
      shippingMethod: str(obj(order.shipping)["method"]),
      lines: lines.map((l) => ({
        external_product_id: str(l.external_product_id),
        printify_variant_id: Number(l.printify_variant_id),
        quantity: Number(l.quantity),
        line_external_id: str(l.line_external_id) || lineExternalId(orderId, Number(l.line_index)),
      })),
    });
  } catch (e) {
    // Never send a partial or ambiguous order; park it for a human instead.
    const message = String((e as Error).message).slice(0, 400);
    await releaseClaim(admin, orderId, str(claim.claim_token), false, null, message);
    return json(422, { ok: false, error: message, state: "manual_review" });
  }

  const settings = await loadSettings(db);
  const create = await pfy(token, `/shops/${shopId}/orders.json`, { method: "POST", body: payload });
  const outcome = interpretSubmitResponse(create.status, create.body);

  if (outcome.kind === "submitted" || outcome.kind === "duplicate") {
    const pfyId = outcome.printifyOrderId;
    // A 409 without an order id means Printify already holds an order with
    // this external_id but did not say which one. The store order cannot be
    // linked to it, so it is parked for a human rather than reported as sent.
    if (!pfyId) {
      const message = "Printify reported a duplicate but did not return the existing order id, so this order cannot be linked to it automatically. Look for an order with this reference in Printify.";
      await releaseClaim(admin, orderId, str(claim.claim_token), false, null, message);
      return json(409, { ok: false, error: message, state: "manual_review", retriable: false });
    }
    const released = await releaseClaim(admin, orderId, str(claim.claim_token), true, pfyId, null);
    if (!released.ok) {
      // The order IS in Printify, but the fulfilment record was not updated.
      // Say so plainly: retrying could create a second order, so this has to
      // be reconciled by hand.
      return json(409, {
        ok: false,
        error: `The order was sent to Printify as ${pfyId}, but the fulfilment record could not be updated (${released.error}). Do not retry — reconcile it in Printify.`,
        state: "manual_review",
        printify_order_id: pfyId,
        retriable: false,
      });
    }

    // Send-to-production is opt-in per settings, because Printify's own store
    // default auto-approves within 24h and charges the merchant card.
    let production = "left for approval in Printify";
    if (settings.auto_send_to_production === true) {
      const send = await pfy(token, `/shops/${shopId}/orders/${pfyId}/send_to_production.json`, { method: "POST" });
      production = send.status === 200 ? "sent to production" : `send_to_production failed: ${pfyError(send.body, send.status)}`;
    }

    return json(200, {
      ok: true,
      state: "submitted",
      printify_order_id: pfyId,
      reconciled_from_duplicate: outcome.kind === "duplicate",
      submitted_lines: payload.line_items.length,
      // The lines deliberately left behind, so a mixed order is visibly a
      // partial fulfilment rather than looking complete.
      held_back_lines: Math.max(0, arr(obj(order).items).length - payload.line_items.length),
      production,
    });
  }

  // Only 'rejected' and 'transient' can reach here — 'submitted' and 'duplicate'
  // returned above. Both variants carry error + status, so no casting is needed.
  const message = str(outcome.error) || `${outcome.kind} (HTTP ${outcome.status})`;
  await releaseClaim(admin, orderId, str(claim.claim_token), false, null, message.slice(0, 400));
  return json(outcome.kind === "transient" ? 503 : 400, {
    ok: false,
    error: message,
    state: "failed",
    // Either way the claim was released back to `failed`, and
    // claim_printify_fulfilment() allows a failed attempt to be re-claimed, so
    // the retry control stays offered. What differs is the advice: a transient
    // reply usually needs nothing changed, a rejection means the payload or the
    // variant mapping is wrong and must be fixed first.
    retriable: true,
    retriable_without_changes: outcome.kind === "transient",
    explanation: "Nothing was sent to production. Retry from the Printify screen once the cause is fixed.",
  });
}

/** Re-read one Printify order so a lost webhook can still be reconciled. */
async function actRefreshOrder(admin: Admin, db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const orderId = str(body.order_id);
  const settings = await loadSettings(db);
  const { token } = await loadCredentials(db);
  const shopId = str(settings.shop_id);

  const { data: ful } = await db.from("order_fulfilment").select("printify_order_id, state")
    .eq("order_id", orderId).maybeSingle();
  if (!ful?.printify_order_id) return json(400, { ok: false, error: "this order has no Printify order id to read back" });

  const r = await pfy(token, `/shops/${shopId}/orders/${ful.printify_order_id}.json`);
  if (r.status !== 200) return json(502, { ok: false, error: pfyError(r.body, r.status) });

  const o = obj(r.body);
  await db.from("order_fulfilment").update({ printify_status: str(o.status), updated_at: new Date().toISOString() })
    .eq("order_id", orderId);

  // Shipments read back from the order object use { carrier, number, url }.
  const shipments = arr<Record<string, unknown>>(o.shipments);
  let applied = 0;
  for (const s of shipments) {
    const number = str(s.number);
    if (!number) continue;
    // Reconcile rows go through the SAME event table and RPCs as live webhooks,
    // so a shipment appears exactly once whether it arrived by push or by
    // re-read, and the timeline guard in apply_printify_shipment() is the only
    // writer either way. The digest is deterministic per (order, tracking
    // number, delivered-ness), so repeated refreshes are deduplicated.
    const eventId = uuidFromDigest(await sha256Hex(`reconcile|${ful.printify_order_id}|${number}|${str(s.delivered_at) ? "d" : "s"}`));
    const delivered = Boolean(str(s.delivered_at));
    const { data: rec } = await db.rpc("record_printify_event", {
      p_event_id: eventId,
      p_topic: delivered ? "order:shipment:delivered" : "order:shipment:created",
      p_resource_type: "order",
      p_resource_id: str(ful.printify_order_id),
      p_payload: s,
    });
    if (obj(rec).duplicate === true) {
      // Already stored from a previous refresh or a real webhook. Still let
      // apply_printify_shipment() run: it is idempotent and a prior attempt may
      // have been recorded but failed before touching the timeline.
      await db.rpc("mark_printify_event", { p_event_id: eventId, p_status: "processed" });
    }
    const { data: done } = await db.rpc("apply_printify_shipment", {
      p_event_id: eventId,
      p_order_id: orderId,
      p_status: delivered ? "delivered" : "shipped",
      p_carrier: str(s.carrier),
      p_tracking_number: number,
      p_tracking_url: str(s.url),
      p_at: str(s.delivered_at || s.shipped_at || new Date().toISOString()),
    });
    if (obj(done).ok !== false) applied++;
    await db.rpc("mark_printify_event", { p_event_id: eventId, p_status: "processed" });
  }

  return json(200, {
    ok: true, printify_status: str(o.status), meaning: printifyStatusMeaning(str(o.status)),
    state: ful.state, shipments_reconciled: applied,
    tracking: shipments.map((s) => ({ carrier: str(s.carrier), number: str(s.number), url: str(s.url), delivered_at: str(s.delivered_at) })),
  });
}

async function actQueue(admin: Admin, db: ReturnType<typeof createClient>) {
  const { data: rows } = await db.from("order_fulfilment")
    .select("order_id, state, printify_order_id, attempts, last_error, printify_status, submitted_at, updated_at")
    .in("state", ["pending_claim", "awaiting_payment", "not_eligible", "failed", "manual_review", "submitting", "submitted", "partially_fulfilled", "fulfilled"])
    .order("updated_at", { ascending: false });
  const ids = arr<{ order_id: string }>(rows).map((r) => r.order_id);
  const { data: orders } = ids.length
    ? await admin.asUser.from("orders").select("id, customer, total, payment, payment_status, status, items").in("id", ids)
    : { data: [] };
  const byId = new Map(arr<Record<string, unknown>>(orders).map((o) => [str(o.id), o]));
  return json(200, {
    ok: true,
    queue: arr<Record<string, unknown>>(rows).map((r) => {
      const o = obj(byId.get(str(r.order_id)));
      return {
        ...r,
        customer: str(o.customer), total: o.total, payment: str(o.payment),
        payment_status: str(o.payment_status), order_status: str(o.status),
        line_count: arr(o.items).length,
        meaning: printifyStatusMeaning(str(r.printify_status)),
      };
    }),
  });
}

/**
 * Orders that have never been claimed, but whose lines do resolve through the
 * variant map. Without this the screen could only show attempts, and nobody
 * could start one.
 *
 * The match is deliberately the SAME equality the SQL claim uses — trimmed
 * exact size and colour against the map row — so nothing appears "ready" here
 * that the claim would then refuse. It is a read-only preview; claim_printify_
 * fulfilment() still re-checks eligibility and takes the row lock.
 */
async function actReady(admin: Admin, db: ReturnType<typeof createClient>) {
  const settings = await loadSettings(db);
  const { data: mapRows } = await db.from("printify_variant_map")
    .select("size, colour, available, external_product_id, printify_products ( product_id, status )");
  const keyed = new Set<string>();
  for (const raw of arr<Record<string, unknown>>(mapRows)) {
    const pp = obj(raw.printify_products);
    const productId = str(pp.product_id);
    if (!productId || str(pp.status) !== "imported" || raw.available === false) continue;
    keyed.add(`${productId}|${str(raw.size).trim()}|${str(raw.colour).trim()}`);
  }
  if (!keyed.size) return json(200, { ok: true, ready: [], note: "no Printify products are linked and mapped yet — sync and import first" });

  const { data: recent } = await admin.asUser.from("orders")
    .select("id, customer, total, payment, payment_status, status, items, created_at")
    .neq("status", "Cancelled").order("created_at", { ascending: false }).limit(60);
  const orders = arr<Record<string, unknown>>(recent);
  if (!orders.length) return json(200, { ok: true, ready: [] });

  const { data: existing } = await db.from("order_fulfilment")
    .select("order_id, state").in("order_id", orders.map((o) => str(o.id)));
  const already = new Set(arr<{ order_id: string }>(existing).map((e) => e.order_id));

  const ready = orders
    .filter((o) => !already.has(str(o.id)))
    .map((o) => {
      const items = arr<Record<string, unknown>>(o.items);
      let printifyLines = 0;
      let printifyQty = 0;
      for (const it of items) {
        const key = `${str(it.productId)}|${str(it.size).trim()}|${str(it.colour).trim()}`;
        if (keyed.has(key)) { printifyLines++; printifyQty += Number(it.quantity ?? it.qty ?? 1); }
      }
      return {
        order_id: str(o.id), customer: str(o.customer), total: o.total,
        payment: str(o.payment), payment_status: str(o.payment_status),
        order_status: str(o.status), created_at: str(o.created_at),
        printify_lines: printifyLines, other_lines: items.length - printifyLines, quantity: printifyQty,
      };
    })
    .filter((r) => r.printify_lines > 0)
    .map((r) => {
      // Same gate the claim applies, in the same words, so nothing shown here
      // as sendable can be refused by claim_printify_fulfilment() moments later.
      const gate = paymentGate(r.payment, r.payment_status, settings.cod_fulfilment_allowed === true);
      return {
        ...r,
        blocked: gate === "allowed" ? "" : GATE_MESSAGE[gate],
      };
    });

  return json(200, { ok: true, ready });
}

/**
 * Register a Printify webhook. The per-webhook HMAC secret is generated here
 * and stored with the credentials.
 *
 * CAVEAT carried from the docs: the rendered reference lists `secret` as a
 * webhook property, but the published OpenAPI create-body shows only topic+url,
 * so whether Printify accepts a caller-supplied secret is confirmed at runtime.
 * If Printify ignores it, the create still succeeds and deliveries arrive
 * unsigned — the response below says which happened, and the receiver refuses
 * unsigned deliveries rather than accepting them.
 */
async function actRegisterWebhook(admin: Admin, db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const settings = await loadSettings(db);
  const { token } = await loadCredentials(db);
  const shopId = str(settings.shop_id);
  const topic = str(body.topic);
  if (!token || !shopId) return json(400, { ok: false, error: "connect and select a shop first" });
  if (!topic) return json(400, { ok: false, error: "topic is required" });
  if (!SITE_URL) return json(400, { ok: false, error: "SITE_URL is not set on the Edge Function" });

  const url = `${SITE_URL}/functions/v1/printify-webhook`;

  // Reuse one secret across topics so every delivery verifies the same way.
  let secret = (await loadCredentials(db)).webhookSecret;
  if (!secret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secret = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    await db.from("printify_credentials").update({ webhook_secret: secret }).eq("id", 1);
  }

  const r = await pfy(token, `/shops/${shopId}/webhooks.json`, { method: "POST", body: { topic, url, secret } });
  if (r.status >= 400) return json(502, { ok: false, error: pfyError(r.body, r.status), url });
  const created = obj(r.body);
  return json(200, {
    ok: true,
    webhook_id: str(created.id),
    topic,
    url,
    // Echoing the secret back to the browser would defeat its purpose.
    secret_stored_server_side: true,
    signature_expected: created.secret === undefined ? "unconfirmed — Printify did not echo a secret; verify a real delivery before trusting tracking" : "sha256=<hmac>",
  });
}

async function actListWebhooks(admin: Admin, db: ReturnType<typeof createClient>) {
  const settings = await loadSettings(db);
  const { token } = await loadCredentials(db);
  if (!token || !str(settings.shop_id)) return json(200, { ok: true, webhooks: [] });
  const r = await pfy(token, `/shops/${settings.shop_id}/webhooks.json`);
  if (r.status !== 200) return json(502, { ok: false, error: pfyError(r.body, r.status) });
  return json(200, {
    ok: true,
    webhooks: arr<Record<string, unknown>>(obj(r.body).data ?? r.body).map((w) => ({ id: str(w.id), topic: str(w.topic), url: str(w.url) })),
  });
}

async function actDeleteWebhook(admin: Admin, db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const settings = await loadSettings(db);
  const { token } = await loadCredentials(db);
  const id = str(body.webhook_id);
  if (!id) return json(400, { ok: false, error: "webhook_id is required" });
  if (!SITE_URL) return json(400, { ok: false, error: "SITE_URL is not set" });
  // Deletion now requires the host to match, as a guard against wiping someone
  // else's registration through a shared token.
  const host = new URL(SITE_URL).host;
  const r = await pfy(token, `/shops/${settings.shop_id}/webhooks/${id}.json?host=${encodeURIComponent(host)}`, { method: "DELETE" });
  if (r.status >= 400) return json(502, { ok: false, error: pfyError(r.body, r.status) });
  return json(200, { ok: true, deleted: id });
}

/**
 * Publish a product through the custom-store workflow. Printify only notifies
 * us that publishing started; the storefront must process the product and then
 * report success or failure, or the Printify product stays locked.
 */
async function actPublish(admin: Admin, db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const settings = await loadSettings(db);
  const { token } = await loadCredentials(db);
  const externalId = str(body.external_product_id);
  const shopId = str(settings.shop_id);
  if (!token || !shopId || !externalId) return json(400, { ok: false, error: "connect, select a shop, and name a product" });

  const start = await pfy(token, `/shops/${shopId}/products/${externalId}/publish.json`, { method: "POST" });
  if (start.status >= 400) return json(502, { ok: false, error: pfyError(start.body, start.status) });

  let processingFailed = "";
  try {
    await rebuildVariantMap(db, externalId);
    const { data: pp } = await db.from("printify_products").select("status, product_id").eq("external_product_id", externalId).maybeSingle();
    if (!pp?.product_id) processingFailed = "product is not linked to a storefront draft";
    else if (pp.status === "unsupported") processingFailed = "no Printify variant fits the site colour/size model";
  } catch (e) {
    processingFailed = String((e as Error).message).slice(0, 300);
  }

  const report = processingFailed
    ? await pfy(token, `/shops/${shopId}/products/${externalId}/publishing_failed.json`, { method: "POST", body: { message: processingFailed } })
    : await pfy(token, `/shops/${shopId}/products/${externalId}/publishing_succeeded.json`, { method: "POST" });

  if (report.status >= 400) {
    return json(502, {
      ok: false,
      error: `processed but could not report back to Printify: ${pfyError(report.body, report.status)}`,
      product_lock_note: "the product may still be locked in Printify — retry the report",
    });
  }
  return json(200, {
    ok: !processingFailed,
    published: !processingFailed,
    error: processingFailed || null,
    note: processingFailed
      ? "Reported publishing_failed so Printify released its lock; fix the mapping and retry."
      : "Product processed and Printify notified of success.",
  });
}

async function actStatus(admin: Admin, db: ReturnType<typeof createClient>) {
  const settings = await loadSettings(db);
  const { data: cred } = await db.from("printify_credentials").select("token_hint, saved_at, webhook_secret").eq("id", 1).maybeSingle();
  const counts = {
    pending: (await db.from("printify_products").select("external_product_id", { count: "exact", head: true }).eq("status", "pending_review")).count ?? 0,
    imported: (await db.from("printify_products").select("external_product_id", { count: "exact", head: true }).eq("status", "imported")).count ?? 0,
    unsupported: (await db.from("printify_products").select("external_product_id", { count: "exact", head: true }).eq("status", "unsupported")).count ?? 0,
    archived: (await db.from("printify_products").select("external_product_id", { count: "exact", head: true }).eq("status", "archived")).count ?? 0,
  };
  const { data: pending } = await db.from("printify_products")
    .select("external_product_id, title, cost_cents, cost_currency, variants, options, product_id, status, available, blueprint_id, print_provider_id")
    .in("status", ["pending_review", "unsupported", "out_of_sync"]).order("first_seen_at", { ascending: false }).limit(50);

  // NEVER include api_token or webhook_secret in a response.
  return json(200, {
    ok: true,
    has_token: Boolean(cred),
    token_hint: str(cred?.token_hint),
    token_expires_at: str(cred?.expires_at),
    has_webhook_secret: Boolean(str(cred?.webhook_secret)),
    enabled: settings.enabled === true,
    shop_id: str(settings.shop_id), shop_title: str(settings.shop_title),
    auto_send_to_production: settings.auto_send_to_production === true,
    cod_fulfilment_allowed: settings.cod_fulfilment_allowed === true,
    cod_policy_note: str(settings.cod_policy_note),
    cod_policy_at: str(settings.cod_policy_at),
    last_test_at: str(settings.last_test_at), last_test_ok: settings.last_test_ok,
    last_error: str(settings.last_error), last_sync_at: str(settings.last_sync_at),
    // The shops the last successful test returned, so the admin can choose
    // between them on load rather than only right after pressing the button.
    shops: arr(settings.last_shops),
    counts,
    pending: arr<Record<string, unknown>>(pending).map((p) => {
      // The variants the site model cannot represent are shown to the admin
      // rather than silently ignored, so a product that can never be produced
      // is visible before an order depends on it.
      const unsupported = variantsWithoutSize(arr(p.variants), arr(p.options));
      return {
        ...p,
        variant_count: arr(p.variants).length,
        cost_pounds: costToPounds(Number(p.cost_cents)),
        unsupported,
      };
    }),
    // The receiver's own topic list, so the browser never has to keep a copy.
    webhook_topics: [...PRINTIFY_TOPICS],
    site: { base: PFY_BASE, webhook_target: SITE_URL ? `${SITE_URL}/functions/v1/printify-webhook` : "" },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-origin": origin || "*" } });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "method not allowed" }, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(500, { ok: false, error: "edge function is missing its Supabase secrets" }, origin);

  const auth = await authenticate(req);
  if (!auth.admin) return json(401, { ok: false, error: auth.error }, origin);
  const admin = auth.admin;

  // Only the read-only, no-side-effect action is allowed while the integration
  // is switched off, so the screen can always be reached to turn it on.
  let body: Record<string, unknown> = {};
  try { body = obj(await req.json()); } catch { return json(400, { ok: false, error: "invalid json body" }, origin); }
  const action = str(body.action);

  const db = service();
  try {
    switch (action) {
      case "status": return await actStatus(admin, db);
      case "saveToken": {
        const token = str(body.token).trim();
        if (token.length < 20) return json(400, { ok: false, error: "that does not look like a Printify token" }, origin);
        await db.from("printify_credentials").upsert({
          id: 1, api_token: token, token_hint: `${token.slice(0, 4)}…${token.slice(-4)}`,
          saved_at: new Date().toISOString(), saved_by: admin.id,
        }, { onConflict: "id" });
        await db.from("printify_settings").update({ last_error: null, updated_at: new Date().toISOString() }).eq("id", 1);
        return json(200, { ok: true, saved: true, note: "Stored server-side. It will never be sent back to a browser." }, origin);
      }
      case "testConnection": return await actTestConnection(admin, db);
      case "selectShop": {
        // The shop is verified against the live list before it is saved, so
        // the browser cannot inject a shop id that the token cannot see, and
        // the stored title comes from Printify rather than from the form.
        const shopId = str(body.shop_id);
        if (!shopId) return json(400, { ok: false, error: "choose a shop first" }, origin);
        const { token } = await loadCredentials(db);
        if (!token) return json(400, { ok: false, error: "save an API token first" }, origin);
        const list = await pfy(token, "/shops.json");
        if (list.status !== 200) {
          return json(502, { ok: false, error: pfyError(list.body, list.status) }, origin);
        }
        const selection = resolveShopSelection(parseShops(list.body), shopId);
        if (!selection.ok || !selection.shop) {
          return json(400, { ok: false, error: selection.error ?? "that shop is not available to this token" }, origin);
        }
        const { data } = await db.from("printify_settings").update({
          shop_id: selection.shop.id, shop_title: selection.shop.title, updated_at: new Date().toISOString(),
        }).eq("id", 1).select("*").single();
        return json(200, { ok: true, shop_id: str(data?.shop_id), shop_title: str(data?.shop_title) }, origin);
      }
      case "setEnabled": {
        // Turning fulfilment ON is the dangerous direction: require a shop and
        // a working connection first. Turning it OFF is always allowed.
        if (body.enabled === true) {
          const s = await loadSettings(db);
          if (!str(s.shop_id)) return json(400, { ok: false, error: "select a shop before enabling fulfilment" }, origin);
          if (s.last_test_ok !== true) return json(400, { ok: false, error: "test the connection successfully before enabling fulfilment" }, origin);
        }
        const { data } = await db.from("printify_settings").update({
          enabled: body.enabled === true, updated_at: new Date().toISOString(),
        }).eq("id", 1).select("enabled").single();
        return json(200, { ok: true, enabled: data?.enabled === true }, origin);
      }
      case "setAutoProduction": {
        const { data } = await db.from("printify_settings").update({
          auto_send_to_production: body.enabled === true, updated_at: new Date().toISOString(),
        }).eq("id", 1).select("auto_send_to_production").single();
        return json(200, { ok: true, auto_send_to_production: data?.auto_send_to_production === true }, origin);
      }
      // COD policy goes through the CALLER-scoped client so the RPC records the
      // authoriser from auth.uid() rather than from a claimed user id.
      case "setCodPolicy": {
        const { data, error } = await admin.asUser.rpc("set_printify_cod_policy", {
          p_allowed: body.allowed === true, p_note: str(body.note),
        });
        if (error) return json(500, { ok: false, error: error.message }, origin);
        return json(data?.ok === true ? 200 : 400, data, origin);
      }
      case "sync": return await actSync(admin, db);
      case "import": return await actImport(admin, db, body);
      case "publish": return await actPublish(admin, db, body);
      case "fulfil": return await actFulfil(admin, db, body, false);
      case "retry": return await actFulfil(admin, db, body, true);
      case "refreshOrder": return await actRefreshOrder(admin, db, body);
      case "queue": return await actQueue(admin, db);
      case "ready": return await actReady(admin, db);
      case "listWebhooks": return await actListWebhooks(admin, db);
      case "registerWebhook": return await actRegisterWebhook(admin, db, body);
      case "deleteWebhook": return await actDeleteWebhook(admin, db, body);
      default: return json(400, { ok: false, error: `unknown action: ${action || "(none)"}` }, origin);
    }
  } catch (e) {
    // Failures stay visible: the admin screen shows this instead of guessing.
    return json(500, { ok: false, error: String((e as Error).message).slice(0, 500) }, origin);
  }
});
