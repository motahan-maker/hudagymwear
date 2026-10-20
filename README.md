# HUDA GYMWEAR

Premium UK women's activewear e-commerce. Guest checkout, GBP, Supabase,
and a Printify print-on-demand fulfilment integration.

> **Your strength. Your style.**

---

## Stack

| Layer | What it is |
|---|---|
| Framework | TanStack Start 1.168 (SSR) on React 19, Vite 8, Nitro 3 |
| Router | TanStack Router 1.170, file-based, `src/routes/` |
| Database | Supabase Postgres + RLS, Storage, Realtime, Auth |
| Server logic | Supabase Deno Edge Functions (`supabase/functions/`) |
| Styling | Tailwind 4 + one hand-written `src/styles.css` design system |
| Tests | Vitest 4 + Testing Library (109 tests) |
| Deploy | Vercel (Nitro `node-server` output in `.output/`) |

## Deployment

`vercel.json` pins the build to the Nitro output:

```json
{ "framework": "nitro", "buildCommand": "npm run build", "outputDirectory": ".output" }
```

`nitro` is a **runtime** dependency rather than a dev dependency so the platform
detects the framework from `package.json` instead of guessing. The build
output is self-contained — `.output/server/index.mjs` serves the app and
`.output/public` the static assets.

The build refuses to run if a privileged credential would reach a browser:

- a `VITE_`-prefixed secret is rejected outright, because that prefix
  guarantees the value is inlined into the public bundle;
- the *value* of any server-side secret that happens to be in the build
  environment is scanned for in every emitted chunk, so a leak is caught
  whatever the variable was called.

A server-side secret merely being present in the build environment is normal
and is not an error — platforms expose project variables to the build. Only an
actual leak fails the build.

## Commands

```sh
npm i
npm run dev          # dev server on http://localhost:8080
npm run build        # production build -> .output/
npm run preview      # serve the build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run sitemap      # regenerate public/sitemap.xml
```

Formatting is separate from linting: `npm run format` runs Prettier. ESLint
does not enforce formatting, so a formatting-only change never hides a logic
change in a diff.

## Layout

```
src/
  routes/          one file per route; the storefront is client-rendered
  components/      shared UI (store.tsx holds the bag, admin.tsx the Brand Studio)
  lib/             data access, business logic, and the browser-side clients
  styles.css       the whole design system: tokens, layout, breakpoints
supabase/
  migrations/      applied in order; never edit an applied migration
  functions/       Deno Edge Functions
  *.sql, *.md      one-off scripts and setup guides
public/            static assets, service worker, sitemap
scripts/           build-time helpers
```

## The two halves of the admin

**Brand Studio** (`/admin`) is the store owner's console: overview, orders,
products, inventory, categories, discounts, reviews, messages, analytics,
Printify, settings. Staff sign in with Supabase Auth; access requires
`profiles.role = 'admin'`.

The React guard decides what is *rendered*. It is not the authorisation. The
authorisation is Postgres RLS, plus a live role check inside the Edge
Function on every privileged call.

There is no admin password in this repository and none may be added. A local
dev machine with no Supabase project configured gets a demo dashboard with no
credential at all; that branch is compiled out of production builds, and
`vite.config.ts` fails any build that would put a secret in a client bundle.

## Where the truth lives

| Fact | Owner |
|---|---|
| Product name, description, imagery, GBP price, badge, visibility, stock | `public.products` — the storefront owns these |
| Production variants, availability, provider cost | Printify, mirrored into `printify_products` / `printify_variant_map` |
| Order money | Postgres (`recalculate_order_v2`), never the browser |
| Customer order status | `orders.status` |
| Payment state | `orders.payment_status` — COD or a manually approved bank transfer |
| Printify fulfilment state | `order_fulfilment.state` — deliberately separate from the other two |
| Admin authorisation | Postgres RLS + `public.is_admin()` |

A Printify catalogue sync must never overwrite the storefront's retail
price, description, imagery, visibility or merchandising. That is enforced in
`upsertPrintifyProducts`, which writes only provider-owned columns.

## Payments

There is no payment provider. Customers pay cash on delivery, or by bank
transfer with a receipt the store owner approves by hand. A bank-transfer
order is not eligible for fulfilment until it is approved — that is enforced
inside `claim_printify_fulfilment`, not in the interface.

## Migrations

Apply in order with the Supabase SQL editor. `supabase/VERIFY.sql` is a
read-only health check; run it after applying.

```
0001_init            0006_realtime_and_categories
0002_storage         0007_open_reviews
0003_security        0008_remove_shopper_accounts
0004_production      0009_push_subscriptions
0005_fix             0010_printify
                     0011_printify_contract
                     0012_storefront_integrity
                     0013_printify_permissions
```

`0012` changes how the order trigger prices an order: a line for a product
that is not in the catalogue is now refused instead of being priced from the
browser. Its preflight query is in `supabase/VERIFY.sql` — run it first.

## Printify

See `supabase/PRINTIFY_SETUP.md`. In short: the Personal Access Token is
entered once in Brand Studio → Printify and stored in a table no browser can
read; the Edge Functions hold the rest. The API token is **not** available in
this repository and the integration is switched off by default.

## Design

The design system is one file: `src/styles.css`. Brand colours, spacing,
type scale and every breakpoint live there, and the `fashion`, `quiet` and
`tool` Button variants are the only ones the storefront uses. Keep new UI
inside that system.
