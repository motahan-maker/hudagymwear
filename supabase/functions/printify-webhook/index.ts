// supabase/functions/printify-webhook — verified Printify event intake
//
// Deployed with --no-verify-jwt: a webhook delivery from Printify carries no
// user session, so Supabase Auth cannot gate it. The ONLY gate here is the
// documented HMAC signature, and it is checked before the body is trusted:
//
//   header  X-Pfy-Signature: sha256=<hex>
//   hex     HMAC-SHA256(raw request body, per-webhook secret)
//
// Three rules this function exists to enforce:
//   1. The signature is computed over the RAW bytes. Parsing to JSON and
//      re-serialising changes key order and whitespace, which would reject
//      every real delivery while accepting a self-made test.
//   2. Comparison is constant-time, and an absent/short/misshapen signature is
//      refused. If no secret is configured the function refuses everything
//      rather than accepting unsigned deliveries — "not configured" must never
//      mean "not checked".
//   3. Nothing here invents delivery state. Only order:shipment:created and
//      order:shipment:delivered may move the customer timeline, through
//      apply_printify_shipment(), which appends 'Shipped'/'Delivered' forwards
//      only. order:updated records Printify's own status string on the
//      fulfilment row and does NOT touch orders.status.
//
// Replies: 200 means "accepted, do not retry". A delivery we understand but
// cannot act on is ACKED (200 + ignored) because Printify retries three times
// and then blocks the webhook for an hour — failing loudly on an event that
// will never succeed just blinds tracking. Auth failures reply 401, and a real
// internal failure replies 500 so the retry actually happens.

// deno-lint-ignore-file no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  normalizeEvent,
  resolveEventId,
  verifyWebhookSignature,
  PRINTIFY_TOPICS,
  type NormalizedEvent,
} from "../_shared/printify-core.ts";
import {
  loadCredentials,
  loadSettings,
  orderIdForPrintifyOrder,
  pfy,
  rebuildVariantMap,
  syncOneProduct,
} from "../_shared/printify-server.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};

const ack = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Apply one verified event.
 * Split out from the HTTP handler so the behaviour is reviewable per topic.
 */
async function applyEvent(
  db: ReturnType<typeof createClient>,
  ev: NormalizedEvent,
  settings: Record<string, unknown>,
  token: string,
): Promise<{ outcome: string; detail?: string }> {
  const shopId = str(settings.shop_id);

  switch (ev.topic) {
    // ------------------------------------------------ tracking -> timeline
    case "order:shipment:created":
    case "order:shipment:delivered": {
      const orderId = await orderIdForPrintifyOrder(db, ev.printify_order_id);
      if (!orderId) {
        // Not one of our orders. Acked, because retrying will not change that.
        return { outcome: "ignored", detail: "printify order id is not linked to a store order" };
      }
      if (!ev.tracking_number && ev.topic === "order:shipment:created") {
        return { outcome: "ignored", detail: "shipment event carried no tracking number" };
      }
      const { data } = await db.rpc("apply_printify_shipment", {
        p_event_id: ev.event_id,
        p_order_id: orderId,
        p_status: ev.topic === "order:shipment:delivered" ? "delivered" : "shipped",
        p_carrier: ev.carrier,
        p_tracking_number: ev.tracking_number,
        p_tracking_url: ev.tracking_url,
        p_at: ev.occurred_at || new Date().toISOString(),
      });
      const res = obj(data);
      if (res.ok === false) return { outcome: "failed", detail: str(res.error) };
      return { outcome: res.ignored ? "ignored" : "processed", detail: str(res.ignored ?? res.status) };
    }

    // ------------------------------------------------ status mirror only
    case "order:updated": {
      const orderId = await orderIdForPrintifyOrder(db, ev.printify_order_id);
      if (!orderId || !ev.printify_status) return { outcome: "ignored", detail: "no linked order or status" };
      await db.rpc("record_printify_order_status", {
        p_order_id: orderId, p_printify_order_id: ev.printify_order_id, p_status: ev.printify_status,
      });
      // 'payment-not-received' means Printify could not charge the merchant
      // account. That is a fulfilment problem, not a customer payment problem,
      // so it goes to manual review rather than changing payment_status.
      if (ev.printify_status === "payment-not-received" || ev.printify_status === "has-issues") {
        await db.from("order_fulfilment").update({ state: "manual_review", last_error: `Printify: ${ev.printify_status}`, updated_at: new Date().toISOString() })
          .eq("order_id", orderId);
      }
      return { outcome: "processed", detail: ev.printify_status };
    }

    // A line Printify cancelled (out of stock, or cancelled by the provider).
    // The order is NOT restocked here. The reason belongs to Printify and the
    // print provider, and putting stock back on sale because an external
    // cancellation was reported would sell a piece that is still being made.
    // The order goes to manual review so a human decides what happens.
    case "order:line-item:canceled": {
      const orderId = await orderIdForPrintifyOrder(db, ev.printify_order_id);
      if (!orderId) return { outcome: "ignored", detail: "printify order id is not linked to a store order" };
      await db.from("order_fulfilment").update({
        state: "manual_review",
        last_error: `Printify cancelled a line: ${ev.printify_status || "cancelled"}`,
        updated_at: new Date().toISOString(),
      }).eq("order_id", orderId);
      return { outcome: "processed", detail: `line cancelled on ${orderId}` };
    }

    // order:created / order:sent-to-production carry no resource data at all.
    case "order:created":
    case "order:sent-to-production":
      return { outcome: "processed", detail: "informational event, no payload to apply" };

    // ------------------------------------------------ catalog
    case "product:created":
    case "product:updated": {
      if (!token || !shopId || !ev.resource_id) return { outcome: "ignored", detail: "cannot re-read the product" };
      // Re-fetch rather than trusting the event body: an out-of-order delivery
      // then simply re-reads current truth instead of applying a stale delta.
      const sync = await syncOneProduct(db, token, shopId, ev.resource_id);
      if (!sync.ok) return { outcome: "failed", detail: sync.error };
      const map = await rebuildVariantMap(db, ev.resource_id);
      return { outcome: "processed", detail: `mapped ${map.mapped}, unsupported ${map.unsupported.length}` };
    }

    case "product:deleted": {
      // Archived, never deleted: fulfilment history must keep pointing at
      // something. The variant map cascade would open a hole in that history,
      // so the map is cleared but the product row stays.
      await db.from("printify_variant_map").delete().eq("external_product_id", ev.resource_id);
      await db.from("printify_products")
        .update({ status: "archived", available: false, updated_at: new Date().toISOString() })
        .eq("external_product_id", ev.resource_id);
      return { outcome: "processed", detail: "archived and unmapped" };
    }

    // ------------------------------------------------ publish handshake
    // For an API-connected store, Printify's publish call only notifies us and
    // LOCKS the product. The website must process it and report back, or the
    // product stays locked forever.
    case "product:publish:started": {
      const externalId = ev.resource_id;
      if (!externalId) return { outcome: "ignored", detail: "no product id in the event" };
      let problem = "";
      if (token && shopId) {
        const sync = await syncOneProduct(db, token, shopId, externalId);
        if (!sync.ok) problem = sync.error || "";
        else {
          const map = await rebuildVariantMap(db, externalId);
          if (!map.mapped) problem = map.reason || "no variants mapped";
        }
      }
      const report = problem
        ? await pfy(token, `/shops/${shopId}/products/${externalId}/publishing_failed.json`, { method: "POST", body: { message: problem } })
        : await pfy(token, `/shops/${shopId}/products/${externalId}/publishing_succeeded.json`, { method: "POST" });
      if (report.status >= 400 && !problem) return { outcome: "failed", detail: "could not report success to Printify" };
      return { outcome: "processed", detail: problem ? `reported failure: ${problem}` : "reported success" };
    }

    // ------------------------------------------------ shop link broke
    case "shop:disconnected": {
      // Stop sending production orders to a shop we can no longer reach.
      await db.from("printify_settings").update({
        enabled: false,
        last_test_ok: false,
        last_error: "Printify reported the shop connection was disconnected; fulfilment switched off",
        updated_at: new Date().toISOString(),
      }).eq("id", 1);
      return { outcome: "processed", detail: "fulfilment disabled" };
    }

    default:
      return { outcome: "ignored", detail: `unhandled topic: ${ev.topic || "(none)"}` };
  }
}

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return ack(500, { error: "edge function is missing its Supabase secrets" });

  // GET is the smoke test in PRINTIFY_SETUP.md. It proves the function is
  // deployed and reports whether signature verification is armed, without
  // ever revealing the secret. Checked BEFORE the POST guard, or it is dead.
  if (req.method === "GET") {
    const probe = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { webhookSecret } = await loadCredentials(probe);
    return ack(200, { ok: true, signature_verification: webhookSecret ? "armed" : "NOT configured - deliveries will be refused" });
  }
  if (req.method !== "POST") return ack(405, { error: "method not allowed" });

  // RAW body, once. Everything downstream uses this exact string.
  const raw = await req.text();
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { webhookSecret, token } = await loadCredentials(db);
  if (!webhookSecret) return ack(401, { error: "webhook signing is not configured on this project" });

  const signature = req.headers.get("x-pfy-signature") ?? req.headers.get("X-Pfy-Signature");
  if (!(await verifyWebhookSignature(raw, signature, webhookSecret))) {
    // Refuse, do not store, do not retry-loop: a forged or mis-keyed delivery.
    return ack(401, { error: "signature verification failed" });
  }

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return ack(400, { error: "body is not json" }); }

  const ev = normalizeEvent(body);
  const env = obj(body);
  // Storage is keyed by uuid. resolveEventId() prefers Printify's own id and
  // otherwise derives a stable uuid from the raw bytes, so a retried delivery
  // always maps to the same row.
  const eventId = await resolveEventId({ topic: ev.topic, resource_id: ev.resource_id }, env);

  const { data: recorded, error: recErr } = await db.rpc("record_printify_event", {
    p_event_id: eventId,
    p_topic: ev.topic,
    p_resource_type: ev.resource_type,
    p_resource_id: ev.resource_id,
    p_payload: env,
  });
  if (recErr) return ack(500, { error: `could not record the event: ${recErr.message}` });
  if (obj(recorded).duplicate === true) {
    // Already applied. Ack so Printify stops retrying, apply nothing twice.
    return ack(200, { ok: true, duplicate: true });
  }

  if (!(PRINTIFY_TOPICS as readonly string[]).includes(ev.topic)) {
    await db.rpc("mark_printify_event", { p_event_id: eventId, p_status: "ignored", p_error: `unknown topic: ${ev.topic}` });
    return ack(200, { ok: true, ignored: "unknown topic" });
  }

  const settings = await loadSettings(db);
  try {
    const result = await applyEvent(db, { ...ev, event_id: eventId }, settings, token);
    await db.rpc("mark_printify_event", {
      p_event_id: eventId,
      p_status: result.outcome === "failed" ? "failed" : result.outcome,
      p_error: result.detail ?? null,
    });
    // 'failed' is replied as 500 so Printify retries a transient DB problem.
    if (result.outcome === "failed") return ack(500, { ok: false, error: result.detail });
    return ack(200, { ok: true, applied: result.outcome, detail: result.detail });
  } catch (e) {
    const message = String((e as Error).message).slice(0, 400);
    await db.rpc("mark_printify_event", { p_event_id: eventId, p_status: "failed", p_error: message });
    return ack(500, { ok: false, error: message });
  }
});
