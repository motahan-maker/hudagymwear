# Working in this repository

## What this is

A production e-commerce application: TanStack Start (SSR) storefront + Brand
Studio admin on Supabase (Postgres, RLS, Storage, Realtime, Auth) with
Supabase Deno Edge Functions for the Printify fulfilment integration.

It is NOT a prototype. There is a real database, real RLS, real order pricing
and a real Printify integration. Treat it that way.

## Rules that exist because breaking them costs money

- **The browser never holds a secret.** No admin password, no service-role
  key, no Printify token in a `VITE_` variable, in `localStorage`, or in any
  response. The build fails if a credential would reach a client bundle.
- **The database prices orders.** `recalculate_order_v2` is the only source
  of an order total. Never let a client-supplied price through, and never
  write the product row back from the browser after an order — it clobbers
  the trigger's atomic stock decrement.
- **A catalogue sync must not overwrite storefront data.** Name, description,
  imagery, GBP retail price, badge, visibility and merchandising belong to
  the storefront. Printify owns production variants, availability and cost.
- **Colour is part of the line.** A bag line is a product, a size AND a
  colour (`src/lib/bag.ts`). The Printify claim joins on the exact
  `(size, colour)` pair, so a lost colour becomes a wrong garment.
- **Payment eligibility is enforced in Postgres.** A bank-transfer order is
  not submittable until an admin approves it. COD needs a recorded funding
  policy. Do not soften these in the interface.
- **The three order state machines stay separate.** `orders.status`
  (customer-facing), `orders.payment_status` (money) and
  `order_fulfilment.state` (Printify) are orthogonal. Merging them is how
  "in-production" ends up shown to a customer as "Packed".
- **Never mark a Printify order cancelled unless the cancellation is
  confirmed.** Do not restock on an unconfirmed external cancellation.

## Working in the code

- `npm run typecheck` and `npm test` must pass before a change is finished.
  `npm run lint` must have no errors.
- Formatting is `npm run format` and is deliberately NOT part of lint, so a
  reformat never buries a logic change in the diff.
- Do not edit an applied migration. Add a new numbered one, with comments
  explaining anything non-obvious, a preflight note, and a rollback path.
- Do not add a dependency without checking that the thing it replaces is
  genuinely needed, and do not add a second copy of something that already
  exists (`src/lib/bag.ts` and `src/lib/admin-metrics.ts` exist so the bag
  model and the admin's arithmetic each have exactly one owner).
- Prefer deleting a duplicated copy over extracting a new abstraction.

## The design system

`src/styles.css` holds the tokens, the layout and every breakpoint. The
`fashion`, `quiet` and `tool` Button variants are the only ones. New UI goes
inside that system; do not introduce a parallel one.

## The storefront

- Routes live in `src/routes/`, one file each. A route is removed by deleting
  the file and adding a permanent redirect in `vercel.json` — never by
  leaving a client-side `<Navigate>` behind, which returns HTTP 200 and
  passes no link equity.
- The catalogue is in `src/lib/catalog.ts`. `products` is a live mutable
  array with a `useSyncExternalStore` subscription; use `useProducts()`,
  `useProduct(id)` or `useActiveProducts()` rather than reading the array
  directly — a direct read will not re-render when the catalogue hydrates.
- Money is formatted with `money()` from `src/lib/catalog.ts`. There is one
  formatter; do not add another.

## The admin

- `src/components/admin.tsx` holds the shell and the pages. Shared
  calculations live in `src/lib/admin-metrics.ts` so the overview, the
  analytics page and the alert engine cannot show the store owner two
  different numbers.
- Stock is edited on the Inventory screen. The product editor shows the
  current stock and links there; it does not write stock.
