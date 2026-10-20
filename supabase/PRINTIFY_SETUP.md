# Printify print-on-demand — one-time setup and handoff

التشغيل مرة واحدة من التلفون:وصّل الحساب، اختر المتجر، فعّل الشحن وقت ما تكون جاهز.
Nothing is sent anywhere until an admin presses **ENABLE FULFILMENT** (step 6), and
every order placed before that is handled exactly as it always was.

This document is the handoff for the Printify work: what exists in the repo, the
exact steps to connect a real account, how to verify each part against Printify,
how to roll back, and what was **not** verified locally because it needs a real
shop, a real token and real money.

---

## 1. Where the work lives

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0010_printify.sql` | Additive schema: settings, credentials, catalogue mirror, variant map, `order_fulfilment`, shipments, webhook events, sync runs + the RPCs. No changes to `orders`. |
| `supabase/functions/_shared/printify-core.ts` | The **pure** half: size/colour mapping, cost units, webhook signature, event identity, payment gates, status vocabulary. Runs unchanged in Deno, in the browser and in vitest. |
| `supabase/functions/_shared/printify-server.ts` | Printify HTTP client, credential/settings reads, catalogue mirror, variant-map rebuild. Shared so the broker and the webhook receiver cannot drift. |
| `supabase/functions/printify/index.ts` | Admin broker. **The only place the Personal Access Token exists.** Verifies the caller, then performs one action. |
| `supabase/functions/printify-webhook/index.ts` | Printify's incoming webhook: raw-body signature check, dedup, then applies shipments/status. |
| `src/lib/printify.ts` | Browser half. Knows nothing about Printify — posts an action name plus the staff member's own session token. |
| `src/components/printify-admin.tsx`, `src/routes/admin/printify.tsx` | Brand Studio → `/admin/printify`. |
| `src/lib/printify.test.ts`, `src/components/printify-admin.test.tsx`, `src/lib/migrations.test.ts` | 44 Printify tests: mapping, signatures, eligibility, idempotency, migration invariants. |

Three state machines are kept separate on purpose — order status (what the shopper
sees), payment status (has the money arrived), fulfilment state (has Printify
accepted the production order). Nothing in this integration collapses them.

## 2. It is inert until you set it up

| Situation | Behaviour |
| --- | --- |
| No Supabase project configured (local demo mode) | `/admin/printify` says "Fulfilment is unavailable here". No token field, no SEND button, zero network calls. Demo mode never charges a card. |
| Supabase configured, migration not applied | Every table read comes back empty — no token shown, no shop, zero products — and the RPCs behind sending an order do not exist yet. Apply step 4 before connecting anything. |
| Migration applied, `enabled = false` (the default) | Configuration still works (token, test connection, catalogue, webhooks) so the screen can be set up. Sending an order is refused **inside Postgres** — `claim_printify_fulfilment()` reads the flag and answers `not enabled`. |
| `enabled = true` + shop + successful test connection | Orders can be sent, one at a time or automatically. |

There is deliberately **no demo version** of any of this: a fake "sent to
production" would teach you to trust a status that means nothing.

---

## 3. Secrets and environment

Dashboard → **Project Settings → Edge Functions → Secrets** (or `supabase secrets set`):

```bash
npx supabase link --project-ref rrhnnywyukkdepvuatlg
npx supabase secrets set SITE_URL=https://hudagymwear.vercel.app
# optional, only if Printify moves the API base:
npx supabase secrets set PRINTIFY_API_BASE=https://api.printify.com/v1
```

| Variable | Where | Notes |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Edge Functions | Injected by the platform. Do not set them yourself. |
| `SITE_URL` | Edge Functions | Used to build the webhook URL and to guard webhook deletion by host. |
| `PRINTIFY_API_BASE` | Edge Functions | Optional override. |
| **Printify Personal Access Token** | `public.printify_credentials` (row id 1) | Entered in the admin UI, **not** an env var, so it can be rotated from a phone without a deploy. |
| **Webhook signing secret** | `public.printify_credentials.webhook_secret` | Generated server-side on first webhook registration. Never returned to a browser. |

Nothing Printify-related goes in a `VITE_` variable. Every `VITE_` value is baked
into the downloadable JS bundle, and the Printify token is a bearer credential
that creates real production orders charged to the merchant payment method.
`public.printify_credentials` is RLS-enabled with **no policies** and
`revoke all … from anon, authenticated`, so not even a signed-in admin's browser
can read it — only the Edge Function holding the service-role key can.

### The token, and the scopes it needs

Printify → **My Profile → Connections → Personal Access Tokens → Generate**.

The token needs these scopes, and no more:

| Scope | Why |
| --- | --- |
| `shops.read` | List the shops on the account so one can be selected |
| `products.read` | Mirror the catalogue |
| `products.write` | Publish a product, report publish success or failure |
| `orders.read` | Reconcile an order when a webhook is missed |
| `orders.write` | Submit an order for production |
| `webhooks.read` | List the registered webhooks |
| `webhooks.write` | Register and remove a webhook |

`catalog.read` is only needed if the catalogue blueprint list is ever read;
the current integration mirrors the shop's products, not the catalogue.
`uploads.read` / `uploads.write` are only needed if artwork is uploaded from
Brand Studio.

**A Personal Access Token is valid for one year.** Record the expiry in
`printify_credentials.expires_at` when you save it, and the admin screen will
warn you before it lapses. A token that has expired makes every fulfilment
attempt fail; it does not fail loudly and early.

The shop itself is created in Printify: **My Stores → Add a new store → API →
Connect**. Each shop has its own products, orders and webhooks, and the shop
id is what every call is scoped to.

### If Printify answers 401 "Unauthenticated"

This is the most common failure and the least informative one. The response
body is `{"error":"Unauthenticated"}` — there is no `message` field, which is
why the admin screen now reads the `error` field too.

The request itself is correct: the documented
`Authorization: Bearer <token>` header with the required User-Agent returns
this same 401. A token that has just been generated and still fails is almost
always one of these, in order:

1. **The token was revoked**, or a newer token was generated for the same
   connection and invalidated it. Generate a fresh one.
2. **The token belongs to a different Printify account** than the one that
   owns the shop. The `aud` claim is the account it was issued for.
3. **The token is a Platform/OAuth token, not a Personal Access Token.** The
   shop endpoints are Personal-Access-Token only.

Decoding the token locally (without sending it anywhere) shows the scopes, the
issue time and the expiry:

```js
const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
console.log(p.scopes, new Date(p.exp * 1000).toISOString());
```

### Checking the connection before anything is deployed

`scripts/printify-verify.ts` is a read-only tool. It never creates a shop, a
product, an order or a webhook, and it never prints the token.

```sh
# The token goes in a gitignored .env.local, or in the environment:
#   PRINTIFY_API_TOKEN=...
npm run printify:verify -- shops
npm run printify:verify -- audit
npm run printify:verify -- products <shopId>
npm run printify:verify -- product  <shopId> <productId>
npm run printify:verify -- webhooks <shopId>
npm run printify:verify -- orders   <shopId>
```

`audit` is the useful one: it lists every product in the shop, resolves each
variant's option ids to its size and colour, reports which variants cannot be
mapped, and counts the mockups and costs.

It needs **Node 22.18 or newer** to run its TypeScript source directly. The
app itself runs on the Node version in `package.json`; only this tool needs
the newer one.

**Do not run it in a loop.** Printify caps error responses at 5% of total
requests, so a token that is being rejected should be fixed, not retried.

## 4. Apply the migrations (additive, and they stay applied)

Apply, in order:

```
0010_printify.sql            the integration itself
0011_printify_contract.sql   the mirror matches the real API shape
0012_storefront_integrity.sql  order pricing refuses a browser-supplied price
0013_printify_permissions.sql the browser may read the Printify tables, not write them
0014_printify_shop_discovery.sql  remembers the shops the token can see
```

Either paste each file into the Dashboard SQL editor, or:

```bash
npx supabase db push        # applies pending migrations only; it never resets
```

**Never run `supabase db reset` against production.** It drops every table in the
project, not just these. Every file is re-runnable (each statement is
`IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP POLICY IF EXISTS` / guarded
`REVOKE`), so re-applying one after an edit is safe.

### Before 0012 — run the preflight

`0012` changes how an order is priced: a line for a product that is **not in
the catalogue** is now refused instead of being priced from the value the
browser sent. That is the change that stops a client ordering a piece of
stock for one penny, and it must not break a real product. Run the
preflight query in `supabase/VERIFY.sql` first — it counts the orders that
reference a product id missing from `products`. **If that count is not zero,
find out why before applying 0012.**

### Rolling 0012 back

`recalculate_order()` is left in place, unchanged. To go back to it:

```sql
drop trigger if exists trg_recalculate_order on public.orders;
create trigger trg_recalculate_order before insert on public.orders
  for each row execute function public.recalculate_order();
```

No data is changed by the swap, so the rollback is immediate.

It adds — nothing else:

- `printify_settings` (singleton; `enabled`, `auto_send_to_production`,
  `cod_fulfilment_allowed` all **start false**)
- `printify_credentials` (service-role only, see above)
- `printify_products`, `printify_variant_map` (the catalogue mirror; cost in
  **minor units**, never a sell price)
- `order_fulfilment`, `order_fulfilment_lines` (claim token, attempts, state)
- `printify_shipments`, `printify_webhook_events`, `printify_sync_runs`
- RPCs: `set_printify_cod_policy`, `claim_printify_fulfilment`,
  `release_printify_fulfilment`, `record_printify_event`, `mark_printify_event`,
  `apply_printify_shipment`, `record_printify_order_status`

Verify it landed (SQL editor):

```sql
select enabled, auto_send_to_production, cod_fulfilment_allowed from public.printify_settings;
-- one row, all three false

select relrowsecurity from pg_class where relname = 'printify_credentials';
-- true

select count(*) from pg_policies where tablename = 'printify_credentials';
-- 0 — RLS with no policy means readable by nobody but service_role

select policyname from pg_policies where tablename = 'printify_settings';
-- printify_settings_admin_all — every printify policy is gated on public.is_admin(),
-- so anon and non-admin staff see nothing, with or without a session.
```

## 5. Deploy the two functions

```bash
npx supabase functions deploy printify
npx supabase functions deploy printify-webhook --no-verify-jwt
```

`printify` keeps Supabase's JWT verification **on** — every request is also
re-verified inside the function (`auth.getUser()`, then `profiles.role = 'admin'`
read back through RLS, then privileged RPCs executed with the **caller's**
client so `public.is_admin()` applies again in Postgres). The client-side
`<AdminGuard>` decides what to render; it is not the security boundary and
nothing trusts it.

`printify-webhook` must use `--no-verify-jwt`: Printify has no user session. Its
gate is the HMAC signature over the **raw request body**
(`X-Pfy-Signature: sha256=<hex>`), and it refuses — without storing — anything
that does not verify.

## 6. Connect the account (all of this is in the admin UI)

1. Sign in to Brand Studio → open **`/admin/printify`**.
2. **Connection** → paste the Personal Access Token (Printify → **Settings → Printify
   API**; it is shown once, treat it like a password) → **SAVE TOKEN**. The response
   echoes only a `token_hint` (`abcd…wxyz`); the token itself never comes back.
3. **TEST CONNECTION** → lists shops. Pick one with **USE THIS SHOP**.
4. Read **Money rules**, then turn on what you actually want:
   - **ENABLE FULFILMENT** — refused until a shop is selected *and* a test connection
     succeeded. **TURN OFF FULFILMENT** is always allowed.
   - **Send accepted orders to production automatically** — off means the order
     appears in Printify waiting for you to approve it by hand; on sends it straight
     to production and charges the payment method on file.
   - **Cash on delivery → RECORD A POLICY** — needs a note of 20+ characters and
     records **who** authorised it and **when**. See the warning below.
5. **Printify catalogue** → **SYNC CATALOGUE** mirrors the shop (it never overwrites
   the storefront fields you own — category, visibility, retail price — and a product
   that disappears from Printify is archived, not deleted, so fulfilment history still
   points at something). Then per product: **CREATE DRAFT** (name, category, your sell
   price, which colours to sell) → **PUBLISH**. If it shows `unsupported` or
   `out_of_sync`, use **RE-LINK**.
   - Anything Printify offers that the site cannot represent goes to review with a
     written reason; it is never silently put on sale.
   - A draft created here is saved as **Draft** — invisible to shoppers until you
     activate it on the Products screen. Nothing publishes itself to the storefront.
   - **PUBLISH** runs Printify's publish → process → report-back cycle, and reporting
     failure is what releases Printify's product lock, so a refused publish is visible
     instead of leaving the product stuck.
6. **Tracking webhooks** → register the topics (see step 7).

### The COD rule, in plain words

Printify charges **your** saved payment method for every production order. It
never collects cash from a customer. So switching on COD fulfilment is not a claim
that Printify will chase the courier payment — it is your recorded statement that
the goods are funded and the cash is collected by your own arrangement off
platform. Until that note exists, a COD order is held in `manual_review` by the
database itself, not by the UI.

## 7. Webhooks: register, and confirm signing for real

The **Tracking webhooks** panel offers exactly these three topics; registering one
generates and stores the signing secret server-side:

| Topic | Effect |
| --- | --- |
| `order:shipment:created` | Appends `Shipped` + carrier/tracking to the order timeline |
| `order:shipment:delivered` | Appends `Delivered` |
| `order:updated` | Mirrors Printify's order status; **never** changes `orders.status` |

Other topics the receiver understands (`order:created`,
`order:sent-to-production`, `product:created/updated/deleted`,
`product:publish:started`, `shop:disconnected`) are handled if a webhook ever
arrives for them, but they are not offered in the dropdown because the fulfilment
record and the sync already cover them. `shop:disconnected` is the notable one: it
switches fulfilment off automatically.

Only verified Printify shipment events may add `Shipped`/`Delivered`, and only
forward: a late `created` after `Delivered` cannot downgrade the timeline, and a
`Cancelled` order is never re-shipped.

> **Unconfirmed by Printify's docs, must be tested:** whether the webhook create
> endpoint actually accepts the `secret` field. The broker sends it and reports
> `signature_expected` back — if Printify does not echo a secret, the message says
> *"unconfirmed — verify a real delivery before trusting tracking"*. Until you see
> a signed delivery land (below), treat tracking as best-effort and reconcile by
> the **Re-read** button on a fulfilment row, which pulls shipments directly from
> the API instead of waiting for a push.

Smoke-test the receiver (no session needed, reveals nothing):

```bash
curl -s https://rrhnnywyukkdepvuatlg.supabase.co/functions/v1/printify-webhook
# → {"ok":true,"signature_verification":"armed"}
# "NOT configured - deliveries will be refused" means no webhook has been registered yet
```

Then prove one real delivery end to end: register the webhook, trigger a shipment
in Printify, and check

```sql
select topic, status, error, received_at
  from public.printify_webhook_events order by received_at desc limit 10;
-- status: received -> processed | ignored | failed
```

`failed` or `ignored` with an error text is a delivery we refused or could not
attribute — visible in the log rather than silently dropped. `ignored` on
"printify order id is not linked to a store order" simply means the event belongs
to a shop order this site never placed.

## 8. Verify the money path before trusting it

There is **no sandbox** in Printify. Every test order is a real production order
charged to the payment method on the account. Before pressing anything:

- Use a dedicated **test store** (a second shop in Printify) or accept the cost of
  one real garment, and cancel it in Printify immediately.
- Brand-new Printify stores hold the first orders for approval and are normally
  cleared for automatic approval within about 24 hours — that is Printify's side, and
  this app never assumes it. With **Send accepted orders to production
  automatically** off, an order simply waits in Printify, and the fulfilment row
  reports the waiting state instead of inventing progress.
- Confirm the cost the site stores equals Printify's `cost` field in the same
  **minor units** (cents), not a price: `printify_products.cost_cents`.
- Confirm a bank-transfer order cannot be sent before `payment_status = 'Paid'`
  (it lands in `awaiting_payment`), and that the "Ready to send" list and the
  database refuse it with the *same* wording.

A safe first real test is one item, one size, your own address, tracked delivery.

## 9. Rollback

Disable Printify webhook registrations and fulfillment from the admin integration
UI first. To roll back the application, restore the prior code deployment.
Migration 0010 is additive and should normally be left in place to preserve
imported identifiers and fulfillment history. A schema rollback would discard
integration metadata and must only be prepared/executed after a production backup
and explicit owner review; no automatic destructive rollback is provided.

In practice:

1. `/admin/printify` → **Tracking webhooks** → delete each one (this needs the
   host match guard, so `SITE_URL` must be set).
2. Turn **Enable fulfilment** off. The database then refuses every claim.
3. Restore the previous Vercel deployment. The tables stay; the old code simply
   never reads them.
4. Do **not** drop the tables. `printify_products.external_product_id` and
   `order_fulfilment.printify_order_id` are the only link between your orders and
   Printify's production records.

## 10. Corrections vs the retired "integrator" API

Anyone reviewing this against older tutorials will find those examples return
404/400. This code is written against the current Public API
(developers.printify.com + `openapi.json`, checked 2026-10):

| Retired | Current (what this code sends) |
| --- | --- |
| `POST /shops/{id}/printify_orders.json` | `POST /shops/{id}/orders.json` |
| `items[]`, `printify_product_id` | `line_items[]`, `product_id` |
| `shipping_to` | `address_to` |
| `label_id` / `label_template_id` | `label` |
| per-order `cost` / `currency` request | removed; costs are Printify-side, read from variants |
| `PENDING` / `IN_PRODUCTION` / `IN_TRANSIT` | `pending` / `in-production` / `fulfilled` (lowercase) |
| `GET /user/shops` | `GET /shops.json` |
| `Idempotency-Key` header | does not exist — duplicate `external_id` returns **409 / code 8503** |
| shipment `id` as the order id | the order id is `data.order_id`; `resource.id` is the *shipment* id |

Two consequences that shaped the design:

- **Idempotency is ours.** Because there is no `Idempotency-Key`, `external_id` is
  the order id (`p_order_id` in the claim), and a 409 is treated as
  "already submitted" and reconciled rather than retried blindly. Line items get a
  stable `external_id` derived the same way, so a partial retry cannot duplicate a
  garment.
- **Duplicate deliveries are handled at the door.** `record_printify_event` does
  `on conflict (event_id) do nothing` and answers `{duplicate: true}`, so Printify
  can retry as often as it likes and the timeline moves once.

## 11. What was verified locally (and how)

No production migration, no write to the live database, no deploy, and no
`supabase db reset` were performed. Everything below ran against local copies or
an in-memory Postgres.

| Check | Command | Result |
| --- | --- | --- |
| Unit + component + migration invariants | `npm run test` | 13 files / 99 tests pass (44 new Printify) |
| Types (app + shared core, via the test import) | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| Edge Function sources (Deno is not installed here) | see harness below | exit 0 |
| Production build | `npm run build` | builds clean |

**Type-checking the Deno sources without Deno.** `supabase/functions/**` is not in
`tsconfig.json`, and `_shared/printify-core.ts` is only covered because
`src/lib/printify.test.ts` imports it. The two `index.ts` entry points are checked
by a temporary harness outside the repo: copy `supabase/functions/`, add an
ambient `Deno` + `npm:@supabase/supabase-js@2` stub, and run the repo's own `tsc`
with `strict`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`
and `noUncheckedIndexedAccess`. Recreate it when needed — it is a verification
tool, not source, and is deliberately **not** committed.

**Migration 0010 without a server.** It was executed against
[`@electric-sql/pglite`](https://pglite.dev) (in-memory Postgres; no network, no
project), then asserted: every object created, defaults off, credential table
unreachable by `anon`/`authenticated`, a non-admin `claim` refused, a COD claim
held in `manual_review` until a policy note exists, a paid bank order claimable,
the same `external_id` refused twice, `apply_printify_shipment` refusing to
downgrade or un-cancel. 47/47 assertions passed. `pglite` is intentionally **not**
a dependency of this repo (a 30 MB dev-only binary that would drift from the real
Postgres); install it in a scratch directory if you want to re-run that:

```js
// scratch, run from the repo root: npm i @electric-sql/pglite, then
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();                       // in-memory; touches nothing
await db.exec(readFileSync('supabase/migrations/0010_printify.sql', 'utf8'));
const row = await db.query(
  'select enabled, cod_fulfilment_allowed from public.printify_settings');
console.log(row.rows);                          // [{ enabled: false, cod_fulfilment_allowed: false }]
```

The tests found and fixed four real defects rather than describing intent:
`2 XL`/`2xl` were canonicalising to two different sizes (they now both land on
`XXL`); `UK` was passing through as a country code, which is not ISO 3166-1 and
would have been rejected **after** the claim was taken; shipment events were
attributing `resource.id` (the shipment id) as the order id, so tracking would
never have attached; and two colour/size classification rules were dead code
because the size normaliser echoed unknown words back truthy.

## 12. Known gaps and follow-ups

- **The API contract has been checked against the published OpenAPI
  specification, not against the live service.** Three shape mismatches were
  found and fixed by reading `https://developers.printify.com/openapi.json`:
  a shop product's variant carries **option ids** (`options: [1189, 1191]`)
  and the labels live on the parent product; `product.images` is a list of
  **objects** (`{src, variant_ids, position, is_default}`), not URL strings;
  and the create-order payload needs `shipping_method`, `label`,
  `address2` and `region`. Step 13 is the live confirmation of all three.
- **The cost currency is not stated by the API.** The variant carries a
  `cost` in minor units and the catalog's own shipping profiles are
  denominated in USD, so no margin is shown in the admin until the currency
  is confirmed. `printify_products.cost_currency` records it once known.
- **Shipment dedup depends on a non-null `event_id`.** The unique index is
  `printify_shipments (order_id, event_id)`, and Postgres treats NULLs as distinct,
  so the `on conflict do nothing` only bites when an event id is present. Both
  writers guarantee one: webhooks pass the resolved uuid, and re-reads derive a
  deterministic uuid from `reconcile|<printify order>|<tracking number>|<shipped|delivered>`.
  If a third writer is ever added it must do the same, or tracking rows will repeat.
- **The catalogue sync needs 0011.** `upsertPrintifyProducts` writes the
  option definitions and the mockup URL list, which are new columns. Without
  0011 the sync fails with `catalog write failed: column printify_products.options
  does not exist` — the admin shows the message rather than a silent empty
  catalogue, but the fix is to apply 0011.
- **A missing migration looks like "nothing configured".** `actStatus` reads the
  mirror tables without checking each query's error, so if 0010 was never applied the
  panel shows zeros instead of `relation "printify_settings" does not exist`. Apply
  step 4 first; if the counts stay at zero after a successful token save, that is the
  cause. Surfacing the error text is a small follow-up in
  `supabase/functions/printify/index.ts`.
- **Signing is unverified against a live delivery** (see step 7). Reconciling by
  read is the fallback.
- **The `secret` sent when creating a webhook is not in the OpenAPI
  specification.** The documented create body is `{topic, url}`. The secret is
  supported in practice — the integration generates one locally and sends it —
  but the documentation does not list it, so it is confirmed by a real delivery
  in step 13 rather than assumed.
- **One shop per install.** `printify_settings` is a singleton; a second Printify
  shop needs a schema change.
- **Checkout offers one country** (`United Kingdom`) and the site palette is
  finite: a Printify colour with no website equivalent goes to review instead of
  sale, which is correct but will show up as `unsupported` noise until the
  catalogue is curated.
- **`auto_send_to_production` is a manual decision per store**, not a migration
  default; nothing turned itself on.
- **No automatic live migration** exists or is planned: applying the migrations
  is a human step with a backup taken first.

---

## 13. Live verification checklist (needs the token)

Nothing below has been executed. Each line is a step, the result to expect,
and what it proves. Do them in order; the first three are free and the rest
involve a real order that is charged to the merchant card.

| # | Step | Expected | Proves |
| --- | --- | --- | --- |
| 1 | `GET /v1/shops.json` with the new token | The shop list, including the API shop you connected | The token and its scopes work |
| 2 | `GET /v1/shops/{id}/products.json?page=1&limit=50` | A product whose `variants[].options` are **numbers** and whose `options[]` carry the labels | The option-id shape the mapper now resolves |
| 3 | Look at one product's `images[]` | Objects with a `src` | The mockup parser reads the right field |
| 4 | Look at one variant's `cost` and the print provider's country | A number in minor units, currency **not** stated | Whether a margin may be shown at all |
| 5 | `POST /v1/shops/{id}/webhooks.json` with `{topic, url, secret}` | The webhook is created | Whether the `secret` field is honoured |
| 6 | `POST /v1/shops/{id}/webhooks/{id}/simulate` | A signed delivery arrives at the webhook and the receiver accepts it | The HMAC verification, without a real order |
| 7 | `POST /v1/shops/{id}/orders/shipping.json` with the store's address | The available shipping methods and their prices | Which `shipping_method` the store's tiers map to |
| 8 | One real order, cheapest item, quantity 1 | A Printify order with the right variant, quantity and address | The whole submission path |
| 9 | `GET /v1/shops/{id}/orders/{id}.json` | The order, its status and its shipments | The status vocabulary the admin displays |
| 10 | `POST /v1/shops/{id}/orders/{id}/cancel.json` on an unpaid order | The order is cancelled | The cancellation path, before any money moves |

**While verifying:** leave `enabled = false` and
`auto_send_to_production = false`. With fulfilment off, the claim refuses
inside Postgres, so nothing can be sent to production by accident. Turn
`enabled` on only for step 8, and turn it straight back off afterwards.

**After verifying:** record the token expiry in
`printify_credentials.expires_at`, record the cost currency in
`printify_products.cost_currency`, and note the shipping method mapping for
the store's two tiers.

---

## 14. Before fulfilment is switched on

Fulfilment is off by default and stays off until every one of these is true.
This is the list, not a description.

**The order itself**

- [ ] The order total was computed by `recalculate_order_v2`, in Postgres. The
      browser never chose the price.
- [ ] Every line on the order resolves to a Printify product **and** a
      Printify variant, through `printify_variant_map`. A line with no map row
      is held back and stays on the order; it is never produced on a guessed
      variant.
- [ ] The line's colour and size are the ones the customer chose. They travel
      in `orders.items[].colour` / `.size` from the bag through the checkout
      into the order, and the claim joins on exactly that pair.
- [ ] The quantity is positive and the stock check passed.
- [ ] The delivery address is complete, the country is a real ISO 3166-1
      alpha-2 value, and the shipping method maps to one Printify actually
      offers for that destination.

**The money**

- [ ] The payment is eligible. A bank transfer must have been **approved** by
      an admin (`payment_status = 'Paid'`); the claim refuses it otherwise.
- [ ] Cash on delivery is only fulfilled if `cod_fulfilment_allowed` is on and
      a funding/collection policy note of at least 20 characters is recorded,
      with the admin's name and the time. **This is not a formality.** Printify
      has no payment-collection endpoint and charges the merchant account;
      collecting cash from a customer on delivery while Printify is paid
      separately is a funding decision, and it is the store owner's to make
      and to record.
- [ ] The production cost's currency is known, so the margin shown is real.

**The mechanism**

- [ ] `auto_send_to_production` is **off**. With it on, an accepted order goes
      straight to production; Printify's own store default auto-approves
      within 24 hours and charges the merchant card.
- [ ] `enabled` is on, a shop is selected, and the connection test passed.
- [ ] The shop is the HUDA GYMWEAR one. It is never guessed.

**The record**

- [ ] `order_fulfilment` has the store order id, the Printify order id, and
      the claim token. The Printify order id is what a later webhook is
      matched on.
- [ ] The `external_id` sent to Printify is the **store order id**, not the
      attempt. It is the idempotency key: a retry after a dropped response
      comes back as a 409 and is reconciled, not produced twice.

**A first, real order**

- [ ] One order, the cheapest item, quantity one, with the shop's own delivery
      address.
- [ ] It is watched from submission to delivery, and the customer timeline
      moves on its own from the webhooks.
- [ ] The Printify order shows the right variant, quantity and address.

---

## 15. Setting up a controlled webhook test

Printify cannot reach `localhost`. A webhook needs a public HTTPS URL, and
the receiver must not be left open to the internet just for a test.

**What is needed**

1. A public HTTPS URL for the receiver, which is:
   `https://<project-ref>.supabase.co/functions/v1/printify-webhook`
   The webhook receiver is a deployed Edge Function, so this URL already
   exists once the function is deployed. `SITE_URL` is used to build it and to
   guard webhook deletion by host.
2. A signing secret that both sides hold. The integration generates one and
   stores it in `printify_credentials.webhook_secret`; it is never returned to
   a browser. The `secret` field sent when creating a webhook is **not in the
   published OpenAPI specification** — it is supported in practice, and step 6
   of the live checklist confirms it with a real delivery rather than
   assuming it.
3. The `printify-webhook` function deployed with `--no-verify-jwt`. Printify
   has no user session; the gate is the HMAC signature over the raw body.

**The safe order of operations**

- Deploy the receiver first.
- Register the webhook **from the admin screen**, which generates and stores
  the secret and reports whether Printify echoed one back.
- Verify with `POST /v1/shops/{shop_id}/webhooks/{webhook_id}/simulate`
  before any real order exists. A simulation creates nothing, costs nothing
  and produces a signed delivery.
- Only then place a real order.

**Why a tunnel is not enough on its own**

A tunnel gives a public URL, but the URL changes every time it restarts, so
the registered webhook would point at nothing. Use the deployed Supabase
function URL, which is stable.

**What the receiver does with a delivery**

1. Read the raw body **once** and use that same string for the signature and
   for the parse. Re-serialising the JSON changes the bytes and breaks the
   signature.
2. Verify the HMAC over the raw body with the stored secret, comparing in
   constant time. A missing or unconfigured secret refuses every delivery
   rather than trusting an unsigned one.
3. Record the event under its id before applying it, so a redelivery is
   recognised and applied once.
4. Apply the shipment, forwards only: a delivered event never moves a
   timeline backwards, and a cancelled order is never undelivered.
5. Acknowledge anything it understands, including an event it cannot act on —
   Printify retries three times and then blocks the webhook for an hour, and
   failing loudly on an event that will never succeed only blinds tracking.
6. Answer a real internal failure with 500, so the retry actually happens.