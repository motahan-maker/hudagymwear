// supabase/functions/order-push — closed-app admin alerts (Web Push sender)
//
// WHAT IT DOES
//   Supabase Realtime can only ring a browser that is still alive, so a new
//   order placed while the Brand Studio is shut would be silent. A Database
//   Webhook (Studio → Automation → Webhooks, INSERT on public.orders) POSTs the
//   new row here; this function reads the admin devices registered in
//   `push_subscriptions` (migration 0009) and encrypts one Web Push payload per
//   device. The browser then wakes public/sw.js, whose `push` handler shows the
//   notification — with the app fully closed.
//
//   The payload carries only what a notification may show (order number, total,
//   item count, payment method, deep link). No addresses, no phone numbers, no
//   customer email: push endpoints are third-party URLs (Google/Apple/Firefox),
//   so anything sent here must be safe to leave the building.
//
// AUTH
//   Deployed with --no-verify-jwt (a database webhook has no user session), so
//   the shared secret header is the only gate:
//     x-huda-webhook-secret: <PUSH_WEBHOOK_SECRET>
//   Requests without it are rejected before Supabase is touched.
//
// ENV (Dashboard → Settings → Edge Functions → Secrets)
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  from `npx web-push generate-vapid-keys`
//   VAPID_SUBJECT                         mailto:you@example.co.uk
//   PUSH_WEBHOOK_SECRET                   a long random string
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//   SERVICE_ROLE IS NEVER SHIPPED TO THE BROWSER — it lives only here.
//
// SETUP + VERIFICATION: see supabase/PUSH_SETUP.md

import { createClient } from "npm:@supabase/supabase-js@2";
// deno-lint-ignore-file no-import-prefix
import webpush from "npm:web-push@0.1.3";

type WebhookPayload = {
  type?: string;
  table?: string;
  record?: Record<string, unknown> | null;
};

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-huda-webhook-secret",
  "access-control-allow-methods": "POST,GET,OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });

/** Money is stored minor-unit-ish numerics; keep the notification readable. */
function money(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return `£${n.toFixed(2)}`;
}

function orderAlert(record: Record<string, unknown>) {
  const id = String(record.id ?? "");
  const total = money(record.total);
  const items = Array.isArray(record.items) ? record.items : [];
  const payment = String(record.payment ?? "cod");
  const customer = String(record.customer ?? "");
  const parts = [
    total,
    items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "",
    payment === "transfer" ? "Bank transfer" : "Cash on delivery",
  ].filter(Boolean);
  return {
    id: `push-order-${id}`,
    type: "order",
    title: `New order ${id}`,
    body: `${parts.join(" · ")}${customer ? ` — ${customer}` : ""}`,
    link: "/admin/orders",
    at: new Date().toISOString(),
  };
}

async function sendTo(sub: { endpoint: string; keys_p256dh: string; keys_auth: string }, payload: unknown) {
  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth } },
      JSON.stringify(payload),
      { TTL: 600 },
    );
    return { statusCode: res.statusCode, gone: false };
  } catch (err) {
    // web-push throws with a numeric `statusCode` for burnt endpoints:
    // 404/410 mean the subscription is dead and must stop being retried.
    const statusCode = (err as { statusCode?: number }).statusCode ?? 0;
    return { statusCode, gone: statusCode === 404 || statusCode === 410 };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const secret = Deno.env.get("PUSH_WEBHOOK_SECRET") ?? "";
  const got = req.headers.get("x-huda-webhook-secret") ?? "";
  if (!secret || got !== secret) return json(401, { error: "unauthorised" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicVapid = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateVapid = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!url || !serviceKey || !publicVapid || !privateVapid) {
    return json(500, { error: "push is not configured on this project" });
  }
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@huda-gymwear.co.uk", publicVapid, privateVapid);

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // GET is the smoke test in PUSH_SETUP.md: does the secret work and are there
  // devices registered? It never lists endpoints.
  if (req.method === "GET") {
    const { count } = await supabase
      .from("push_subscriptions")
      .select("endpoint", { count: "exact", head: true })
      .is("expired_at", null);
    return json(200, { ok: true, live_subscriptions: count ?? 0 });
  }
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let body: WebhookPayload;
  try {
    body = (await req.json()) as WebhookPayload;
  } catch {
    return json(400, { error: "invalid json" });
  }

  // Supabase webhooks send { type, table, record, old_record }.
  // Accept a bare row too, so the SQL trigger variant in supabase/ also works.
  const record = (body.record ?? (body as Record<string, unknown>)) as Record<string, unknown>;
  const isOrderEvent = !body.type || (body.type === "INSERT" && body.table === "orders");
  if (!isOrderEvent || !record || typeof record.id !== "string") {
    return json(200, { ok: true, sent: 0, reason: "not an order insert" });
  }

  const alert = orderAlert(record);
  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("endpoint, keys_p256dh, keys_auth")
    .is("expired_at", null)
    .neq("endpoint", "");
  if (error) return json(500, { error: error.message });

  const results = await Promise.all(
    (subs ?? []).map((s) => sendTo(s as { endpoint: string; keys_p256dh: string; keys_auth: string }, alert)),
  );

  const dead = (subs ?? []).filter((_, i) => results[i]?.gone).map((s) => (s as { endpoint: string }).endpoint);
  if (dead.length) {
    await supabase.from("push_subscriptions").update({ expired_at: new Date().toISOString() }).in("endpoint", dead);
  }

  return json(200, { ok: true, sent: results.filter((r) => r.statusCode === 201).length, retired: dead.length });
});
