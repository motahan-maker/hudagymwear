# Closed-app admin alerts (Web Push) — one-time setup

الإشعار يوصل على التلفون والتطبيق مقفول — الخطوات دي مرة واحدة بس.

Right now the Brand Studio rings through **Supabase Realtime**, which only works
while the page is alive. A phone freezes the tab/App within a few minutes of
closing it, so an order placed after midnight is silent. **Web Push** is the
channel the operating system delivers itself — the notification appears even
when the app is completely shut.

There are three layers. The first two already ship; the third needs this setup:

| Layer | What it covers | Ships in the app |
| --- | --- | --- |
| In-app sound + banner | Brand Studio open on that phone | yes |
| System notification | Tab backgrounded / installed PWA in memory | yes |
| **Web Push** | **App fully closed** | needs the 6 steps below |

Everything here is inert until step 3 is filled in: with no `VITE_VAPID_PUBLIC_KEY`
the UI shows "not set up" and no code path touches the network.

---

## 1. Generate the VAPID key pair (the signature push services trust)

```bash
npx web-push generate-vapid-keys --json
```

You get `{"publicKey":"BF…","privateKey":"…"}`. The **public** key goes to the
browser; the **private** key only ever lives on the server. Never put the private
key, or `SUPABASE_SERVICE_ROLE_KEY`, in a `VITE_` variable — every `VITE_` value
is baked into the downloadable JS bundle.

## 2. Create the subscriptions table

Run `supabase/migrations/0009_push_subscriptions.sql` in the Dashboard SQL
editor (or `supabase db push`). It creates `public.push_subscriptions` with
admin-only RLS — an endpoint plus its keys is a bearer credential that lets
whoever holds it notify that device, so customers can never read or write it.

## 3. Give the browser the public key

`.env` for local, and **Vercel → Project → Settings → Environment Variables**
for production (then redeploy):

```
VITE_VAPID_PUBLIC_KEY=BF…(the public one)
```

## 4. Deploy the sender, with its secrets

```bash
npm i -g supabase && supabase login
supabase link --project-ref rrhnnywyukkdepvuatlg
supabase secrets set \
  VAPID_PUBLIC_KEY=BF… \
  VAPID_PRIVATE_KEY=… \
  VAPID_SUBJECT=mailto:you@example.co.uk \
  PUSH_WEBHOOK_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
supabase functions deploy order-push --no-verify-jwt
```

`--no-verify-jwt` is required: a database webhook has no user session, so the
shared secret header (`supabase/functions/order-push/index.ts`) is the gate.
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already injected by the
platform — do not set them yourself, and never expose them to the storefront.

## 5. Tell Supabase to call it on every new order

Dashboard → **Automation → Webhooks → Create a new webhook**:

- Request method `POST`
- URL: `https://rrhnnywyukkdepvuatlg.supabase.co/functions/v1/order-push`
- Database table: `public.orders` → event: **INSERT**
- Headers: `x-huda-webhook-secret` = the `PUSH_WEBHOOK_SECRET` from step 4, and `content-type: application/json`

Enable the webhook and create it *before* anyone registers a phone if you want
zero stray calls; ordering does not otherwise matter.

> One sender only. This dashboard webhook is the supported trigger; do not also
> add a SQL trigger on `public.orders`, or every order pings the phone twice.

The webhook fires *after* the row is committed and never blocks or fails
checkout: if the push call dies, the order is still stored and the in-app
ringer still catches it on the next realtime event.

## 6. Register each admin phone

On each device: open the site in Chrome (Android) or Safari (iOS), **install the
PWA** (Add to Home Screen), sign in to Brand Studio, then
**Alerts → Phone notifications → allow**, and **Alerts when the app is closed →
ACTIVATE PHONE PUSH**. The row appears in `push_subscriptions`.

---

## Verify it (about two minutes)

```bash
# 1. secret + registered devices (never lists endpoints)
curl -H "x-huda-webhook-secret: <SECRET>" \
  https://rrhnnywyukkdepvuatlg.supabase.co/functions/v1/order-push
# → {"ok":true,"live_subscriptions":1}

# 2. send a real one, then close the app entirely and watch the phone
curl -X POST -H "content-type: application/json" -H "x-huda-webhook-secret: <SECRET>" \
  https://rrhnnywyukkdepvuatlg.supabase.co/functions/v1/order-push \
  -d '{"type":"INSERT","table":"orders","record":{"id":"HG-TEST1","customer":"Test","total":129.5,"items":[1,2,3],"payment":"cod"}}'
# → {"ok":true,"sent":1,"retired":0}
```

`sent: 0` with `live_subscriptions: 0` means step 6 was not done on that device.
`retired: 1` means the browser had already dropped that endpoint (the app was
uninstalled or permission revoked) — re-run step 6.

## What this cannot do

- **iOS**: Web Push only reaches an *installed* PWA (Add to Home Screen), iOS 16.4+,
  with notifications allowed. A Safari browser tab that was swiped away will not
  receive it. This is an Apple limit, not a bug in the app.
- **Expired subscriptions**: browsers rotate endpoints; the sender marks a dead
  one `expired_at` and the phone re-registers the next time the studio is opened.
- **Order details in the notification**: deliberately only number, total, item
  count, payment method. Addresses and phone numbers never leave Supabase,
  because push payloads transit Google/Apple/Firefox servers.
- **`npm:web-push` on the edge runtime**: if a deploy ever rejects that import,
  pin a different version or move the sender to a small Node service and point
  the webhook at it — nothing else in the app changes.
- **A scheduled re-check is not a substitute for push.** The service worker also
  asks Chrome for a periodic "huda-order-check" wake-up, which re-announces
  alerts that have been sitting over 20 minutes. Chrome treats that as a
  suggestion (hours apart, or never, on a closed app) and Safari does not
  support it at all — so Web Push above is the only reliable closed-app path.
