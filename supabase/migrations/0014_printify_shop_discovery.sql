-- 0014_printify_shop_discovery.sql
--
-- PURPOSE
--   Remember the shops the token can see, so Brand Studio can show the shop
--   list — and the choice between them — without making an API call on every
--   page load.
--
-- WHY
--   A Printify account can have several shops, and every one of them has its
--   own products, orders and webhooks. Picking the wrong one sends orders to
--   the wrong shop, so the choice is never made automatically: the admin has
--   to choose one, explicitly.
--
--   The list was only ever visible immediately after pressing TEST
--   CONNECTION, and was lost on reload — which made a deliberate choice feel
--   like it had not been made.
--
--   The list is a CACHE of what the last successful test returned. It is
--   refreshed every time the connection is tested, and it is never used to
--   decide anything on its own: `selectShop` re-reads the live list from
--   Printify before saving a choice.
--
-- DATA IMPACT
--   Additive only. One new column, defaulting to an empty list. Nothing is
--   deleted and no existing value changes.
--
-- PRECONDITIONS
--   0010_printify.sql must have been applied.
--
-- RISKS
--   None. The column holds only an id, a title and a sales-channel name.
--
-- ROLLBACK
--   drop column if exists public.printify_settings.last_shops;
--
-- Re-runnable: every statement is guarded.

alter table public.printify_settings
  add column if not exists last_shops jsonb not null default '[]'::jsonb;

comment on column public.printify_settings.last_shops is
  'The shops the last successful connection test returned: [{id,title,sales_channel}]. A cache for the admin screen only; selectShop always re-reads the live list before saving a choice.';
