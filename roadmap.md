# HUDA GYMWEAR — roadmap

State of the store as it stands. Everything ticked is built and in the
repository; everything unticked is a decision, not a plan.

## Store

- [x] Guest checkout: cash on delivery or bank transfer, no accounts
- [x] Server-side order pricing, discount validation and stock decrement
- [x] Catalogue, colours, sizes, imagery, GBP pricing, visibility
- [x] Categories with storefront ordering and show/hide
- [x] Inventory: size-level stock with a low-stock threshold
- [x] Discount codes: percent or fixed, minimum spend, usage cap, date window
- [x] Reviews with admin moderation and brand replies
- [x] Contact, newsletter and launch inbox
- [x] Order management: status pipeline, payment approval, CSV export
- [x] Manual order entry for phone and WhatsApp sales
- [x] Order tracking for guests (order number + email)
- [x] Sales overview, 14-day chart, best sellers, revenue by category
- [x] Store settings, shipping methods, bank details, local backup
- [x] PWA install, offline shell, web push for order alerts
- [x] Responsive across phone, tablet and desktop
- [x] SEO: per-route metadata, product and store structured data, sitemap
- [x] Server-side security headers, CSP, HSTS

## Printify (print-on-demand fulfilment)

- [x] Secure connection: token stored server-side, never in a browser
- [x] Catalogue mirror that never overwrites storefront data
- [x] Variant mapping from the site's (size, colour) to a Printify variant
- [x] Order claim with an atomic lock, payment gate and COD policy gate
- [x] Order submission with a stable idempotency key and duplicate recovery
- [x] Signed webhooks with idempotent event processing
- [x] Shipment and delivery events moving the customer timeline
- [x] Admin panel: connection, money rules, catalogue, queue, webhooks
- [ ] **Live verification.** The Printify API token is not in this
      repository. The integration is switched off until it is connected and
      the API contract has been checked against the live service. See
      `supabase/PRINTIFY_SETUP.md` for the exact steps.
- [ ] Confirm the currency the provider reports production costs in. The
      catalogue does not state it, so no margin is shown until it is known.
- [ ] Confirm which shipping method Printify offers for each destination,
      and that the store's express tier is honoured.

## Decisions still open

- [ ] Are the HUDA GYMWEAR products already created in the Printify shop,
      or should the admin be able to create them from Brand Studio?
- [ ] Is a payment provider wanted, or does COD plus manual bank-transfer
      approval stay the model? Card payments are not offered today and the
      terms, FAQ and structured data all say so.
- [ ] Should `/launch` stay? It is a pre-launch capture page that nothing
      links to and the footer newsletter already covers.
- [ ] Should the Accessories category stay visible while it has no stock?
- [ ] Should the local backup in Settings be replaced with a real
      server-side export? It currently backs up a browser cache, not the
      database.
