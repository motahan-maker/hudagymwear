-- 0010_printify.sql
-- HUDA GYMWEAR — Printify print-on-demand integration (ADDITIVE ONLY)
--
-- WHAT THIS ADDS
--   A separate fulfilment world that sits BESIDE the existing order/payment/
--   timeline model. Nothing in this file alters, renames, or backfills
--   `orders.status`, `orders.payment_status`, or `orders.timeline` in place —
--   the only write path into the customer timeline is
--   `apply_printify_shipment()`, and it appends 'Shipped'/'Delivered' from
--   verified Printify shipment events only.
--
-- WHY A SEPARATE FULFILMENT STATE
--   Order status (what the shopper sees), payment status (has the money
--   arrived) and fulfilment state (has Printify accepted the production order)
--   are three different questions that change at different times. Collapsing
--   them is how fulfilment systems end up telling a customer an order is
--   shipped because a bank transfer was approved. They are separate tables.
--
-- SECURITY MODEL (this is the part that matters):
--   * `printify_credentials.api_token` is readable by service_role ONLY.
--     RLS is enabled with NO policies, so no anon/authenticated request can
--     SELECT, INSERT, UPDATE or DELETE it — not even an admin's browser. The
--     token is written and read exclusively inside the `printify` Edge
--     Function, which holds SUPABASE_SERVICE_ROLE_KEY. It is never returned to
--     a client, never logged, and never placed in a VITE_ variable.
--   * `claim_printify_fulfilment()` is SECURITY DEFINER but is granted to
--     `authenticated` only and checks `public.is_admin()` (from 0003) against
--     auth.uid(). The Edge Function must therefore call it with THE CALLER'S
--     JWT, not the service-role client — a service-role call has auth.uid() =
--     null and is rejected. The client-side AdminGuard is UI polish, not the
--     boundary; this function is.
--   * Event ingestion RPCs are granted to service_role only (a webhook
--     delivery has no user session by definition).
--   * Bank-transfer orders cannot be claimed until payment_status = 'Paid'.
--   * Cash-on-delivery orders cannot be claimed until an authorised admin has
--     recorded a funding/collection policy note. Printify does not collect
--     cash from customers — it charges the merchant account — so this flag is
--     a statement that YOU have arranged the money off-platform. It is not a
--     claim that Printify will chase the courier payment.
--   * Nothing is enabled by default: `enabled` starts false and stays false
--     until an admin turns it on deliberately.
--
-- ROLLBACK: this migration is additive. To disable, set
--   update public.printify_settings set enabled = false;
-- and unregister the webhooks from the admin integration screen (or the
-- Printify dashboard) BEFORE rolling the app back to the previous deploy.
-- Do NOT drop these tables and do NOT run `supabase db reset` against
-- production — the identifiers here are the only link between your orders and
-- Printify's production records. See supabase/PRINTIFY_SETUP.md.
--
-- This file is re-runnable (every statement is IF NOT EXISTS / CREATE OR
-- REPLACE / DROP POLICY IF EXISTS).

-- ---------------------------------------------------------------------------
-- 1. Settings (singleton)
-- ---------------------------------------------------------------------------
create table if not exists public.printify_settings (
  id                    smallint primary key default 1 check (id = 1),
  -- Master switch. false = the Edge Function refuses every fulfilment action
  -- and the storefront/admin show the integration as inert.
  enabled               boolean not null default false,
  shop_id               text,
  shop_title            text not null default '',
  -- When false, submitted orders are left for the admin to approve inside
  -- Printify. Printify's own store default is AUTO-APPROVE WITHIN 24 HOURS,
  -- which silently charges the merchant payment method — see SETUP doc step 6.
  auto_send_to_production boolean not null default false,
  -- COD gating. Requires cod_policy_note before it can be true.
  cod_fulfilment_allowed boolean not null default false,
  cod_policy_note       text,
  cod_policy_by         uuid references public.profiles (id) on delete set null,
  cod_policy_at         timestamptz,
  -- Connection health, surfaced on the admin integrations screen.
  last_test_at          timestamptz,
  last_test_ok          boolean,
  last_error            text,
  last_sync_at          timestamptz,
  updated_at            timestamptz not null default now()
);

comment on table public.printify_settings is
  'Singleton Printify config. Enabled=false by default; COD fulfilment requires a recorded policy note.';

insert into public.printify_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Credentials (service_role only — deliberately unreachable from the client)
-- ---------------------------------------------------------------------------
create table if not exists public.printify_credentials (
  id          smallint primary key default 1 check (id = 1),
  api_token   text not null,
  -- Per-webhook HMAC secret the webhook receiver needs to verify deliveries.
  -- Same isolation as the token: the browser never sees it.
  webhook_secret text not null default '',
  -- Non-secret fingerprint so the admin UI can show something without ever
  -- exposing the token.
  token_hint  text not null default '',
  saved_at    timestamptz not null default now(),
  saved_by    uuid references public.profiles (id) on delete set null
);

comment on table public.printify_credentials is
  'Printify Personal Access Token + webhook HMAC secret. RLS enabled with NO policies: service_role only. Never readable by any browser request.';

alter table public.printify_credentials enable row level security;
-- No policies on purpose. Enabled RLS + zero policies = every anon /
-- authenticated request sees an empty table.
revoke all on table public.printify_credentials from anon, authenticated;
grant all on table public.printify_credentials to service_role;

-- ---------------------------------------------------------------------------
-- 3. Catalog mirror — Printify products, kept separate from merchandising
-- ---------------------------------------------------------------------------
create table if not exists public.printify_products (
  external_product_id text primary key,          -- Printify shop product id (hex)
  shop_id             text not null default '',
  blueprint_id        integer  not null default 0,
  print_provider_id   integer  not null default 0,
  print_provider_country text  not null default '',
  title               text not null default '',
  description         text,
  images              jsonb not null default '[]',
  -- Raw Printify variants (id, sku, cost, options[], is_available). Provider
  -- truth, never edited by the website.
  variants            jsonb not null default '[]',
  -- Website product this was imported into. Null = awaiting review.
  product_id          text references public.products (id) on delete set null,
  status              text not null default 'pending_review'
                      check (status in ('pending_review','imported','out_of_sync','unsupported','archived')),
  -- Provider production cost in MINOR units (Printify reports cents). This is
  -- NOT the GBP retail price; retail lives in products.price / sale_price and
  -- this integration never writes either.
  cost_cents          integer not null default 0 check (cost_cents >= 0),
  currency            text not null default 'GBP',
  available           boolean not null default true,
  first_seen_at       timestamptz not null default now(),
  last_synced_at      timestamptz,
  updated_at          timestamptz not null default now()
);

comment on table public.printify_products is
  'Printify-side product mirror. Category/visibility/retail price are website-owned and live in products; cost_cents is provider production cost, not sell price.';

create index if not exists printify_products_status_idx on public.printify_products (status);
create index if not exists printify_products_website_idx on public.printify_products (product_id);

-- Stable identity: Printify hex id is the natural key, and the website link is
-- one-per-product so a repeated import can never create a second row for the
-- same storefront product.
create unique index if not exists printify_products_website_unique_idx
  on public.printify_products (product_id) where product_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Variant map — the trusted bridge from site colour/size to Printify
-- ---------------------------------------------------------------------------
-- Order submission reads THIS table, not the live Printify payload, so a
-- product that changed upstream cannot silently alter what gets produced.
-- Combos with no row here are not Printify-managed: they stay on the existing
-- order for manual handling instead of being sold into a guess.
create table if not exists public.printify_variant_map (
  external_product_id text not null
    references public.printify_products (external_product_id) on delete cascade,
  size                text not null,
  colour              text not null,
  printify_variant_id integer not null,
  sku                 text not null default '',
  cost_cents          integer not null default 0 check (cost_cents >= 0),
  available           boolean not null default true,
  updated_at          timestamptz not null default now(),
  primary key (external_product_id, size, colour)
);

comment on table public.printify_variant_map is
  'Explicit site size+colour -> Printify variant id. Absence of a row means the combination is not sold through Printify.';

-- ---------------------------------------------------------------------------
-- 5. Fulfilment state (per order) — separate from orders.status / payment
-- ---------------------------------------------------------------------------
create table if not exists public.order_fulfilment (
  order_id          text primary key references public.orders (id) on delete cascade,
  state             text not null default 'pending_claim'
                    check (state in ('pending_claim','awaiting_payment','not_eligible','submitting',
                                     'submitted','partially_fulfilled','fulfilled',
                                     'failed','manual_review','cancelled')),
  printify_order_id text,
  -- A claim is only valid while its token matches, so a worker whose claim has
  -- expired cannot overwrite a newer attempt.
  claim_token       uuid,
  claim_expires_at  timestamptz,
  attempts          integer not null default 0 check (attempts >= 0),
  last_error        text,
  printify_status   text,
  submitted_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.order_fulfilment is
  'Printify fulfilment state per order. Independent of orders.status and orders.payment_status.';

create index if not exists order_fulfilment_state_idx on public.order_fulfilment (state, updated_at desc);

-- Snapshot of the lines that a claim decided are Printify-managed. Written by
-- claim_printify_fulfilment() under the order row lock and read verbatim when
-- submitting, so mixed orders send ONLY their Printify lines and the
-- non-Printify lines are untouched on the existing order.
create table if not exists public.order_fulfilment_lines (
  order_id            text not null references public.orders (id) on delete cascade,
  line_index          integer not null,
  website_product_id  text not null default '',
  name                text not null default '',
  size                text not null default '',
  colour              text not null default '',
  quantity            integer not null check (quantity > 0),
  external_product_id text not null,
  printify_variant_id integer not null,
  line_external_id    text not null,
  claim_token         uuid,
  created_at          timestamptz not null default now(),
  primary key (order_id, line_index)
);

create index if not exists order_fulfilment_lines_claim_idx on public.order_fulfilment_lines (order_id, claim_token);

-- ---------------------------------------------------------------------------
-- 6. Carrier / tracking — Printify data only, never invented
-- ---------------------------------------------------------------------------
create table if not exists public.printify_shipments (
  id              bigint generated always as identity primary key,
  order_id        text not null references public.orders (id) on delete cascade,
  event_id        uuid,
  carrier         text not null default '',
  tracking_number text not null default '',
  tracking_url    text not null default '',
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  source          text not null default 'webhook' check (source in ('webhook','reconcile')),
  created_at      timestamptz not null default now()
);

comment on table public.printify_shipments is
  'Carrier + tracking from verified Printify shipment events or reconciliation reads.';

create index if not exists printify_shipments_order_idx on public.printify_shipments (order_id);
-- One row per (order, event): a replayed webhook cannot duplicate a shipment.
create unique index if not exists printify_shipments_event_dedup_idx
  on public.printify_shipments (order_id, event_id) where event_id is not null;

-- ---------------------------------------------------------------------------
-- 7. Webhook events — persisted + deduplicated
-- ---------------------------------------------------------------------------
create table if not exists public.printify_webhook_events (
  event_id      uuid primary key,
  topic         text not null default '',
  resource_type text not null default '',
  resource_id   text not null default '',
  payload       jsonb not null default '{}',
  status        text not null default 'received'
                check (status in ('received','processed','ignored','failed')),
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

comment on table public.printify_webhook_events is
  'Every accepted Printify webhook, keyed by event id so retries and out-of-order deliveries are idempotent.';

create index if not exists printify_webhook_events_status_idx
  on public.printify_webhook_events (status, received_at desc);
create index if not exists printify_webhook_events_resource_idx
  on public.printify_webhook_events (resource_id);

-- Sync run log: makes "initial import vs update vs archive" counts auditable.
create table if not exists public.printify_sync_runs (
  id          bigint generated always as identity primary key,
  kind        text not null default 'products',
  status      text not null default 'running' check (status in ('running','ok','failed')),
  fetched     integer not null default 0,
  created     integer not null default 0,
  updated     integer not null default 0,
  unchanged   integer not null default 0,
  unsupported integer not null default 0,
  archived    integer not null default 0,
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 8. RLS on the readable tables: admin manages, nobody else touches.
--    The storefront never queries these — shoppers keep seeing orders.status
--    and orders.timeline exactly as before.
-- ---------------------------------------------------------------------------
alter table public.printify_settings     enable row level security;
alter table public.printify_products     enable row level security;
alter table public.printify_variant_map  enable row level security;
alter table public.order_fulfilment      enable row level security;
alter table public.order_fulfilment_lines enable row level security;
alter table public.printify_shipments    enable row level security;
alter table public.printify_webhook_events enable row level security;
alter table public.printify_sync_runs    enable row level security;

drop policy if exists "printify_settings_admin_all"  on public.printify_settings;
drop policy if exists "printify_products_admin_all"  on public.printify_products;
drop policy if exists "printify_variant_map_admin_all" on public.printify_variant_map;
drop policy if exists "order_fulfilment_admin_all"   on public.order_fulfilment;
drop policy if exists "order_fulfilment_lines_admin_all" on public.order_fulfilment_lines;
drop policy if exists "printify_shipments_admin_all" on public.printify_shipments;
drop policy if exists "printify_events_admin_read"   on public.printify_webhook_events;
drop policy if exists "printify_sync_runs_admin_read" on public.printify_sync_runs;

create policy "printify_settings_admin_all" on public.printify_settings
  for all using (public.is_admin()) with check (public.is_admin());
create policy "printify_products_admin_all" on public.printify_products
  for all using (public.is_admin()) with check (public.is_admin());
create policy "printify_variant_map_admin_all" on public.printify_variant_map
  for all using (public.is_admin()) with check (public.is_admin());
create policy "order_fulfilment_admin_all" on public.order_fulfilment
  for all using (public.is_admin()) with check (public.is_admin());
create policy "order_fulfilment_lines_admin_all" on public.order_fulfilment_lines
  for all using (public.is_admin()) with check (public.is_admin());
create policy "printify_shipments_admin_all" on public.printify_shipments
  for all using (public.is_admin()) with check (public.is_admin());
-- Events are written by service_role only; admins get read so the sync log is
-- inspectable, but a browser cannot inject a fabricated event row.
create policy "printify_events_admin_read" on public.printify_webhook_events
  for select using (public.is_admin());
create policy "printify_sync_runs_admin_read" on public.printify_sync_runs
  for select using (public.is_admin());

grant select on public.printify_settings, public.printify_products,
  public.printify_variant_map, public.order_fulfilment, public.order_fulfilment_lines,
  public.printify_shipments, public.printify_webhook_events, public.printify_sync_runs
  to authenticated;
grant insert, update, delete on public.printify_products, public.printify_variant_map,
  public.order_fulfilment, public.order_fulfilment_lines, public.printify_shipments,
  public.printify_settings
  to authenticated;
grant usage, select on sequence public.printify_shipments_id_seq, public.printify_sync_runs_id_seq to authenticated;
grant all on public.printify_products, public.printify_variant_map, public.order_fulfilment,
  public.order_fulfilment_lines, public.printify_shipments, public.printify_webhook_events,
  public.printify_sync_runs, public.printify_settings
  to service_role;

-- ---------------------------------------------------------------------------
-- 9. COD policy note — the only way cash orders become claimable
-- ---------------------------------------------------------------------------
-- Requires a real note (>= 20 chars) and stamps who recorded it. Turning the
-- flag off needs no note, so the safe direction is always one click.
create or replace function public.set_printify_cod_policy(
  p_allowed boolean,
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_note text := btrim(coalesce(p_note, ''));
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'not authorised');
  end if;

  if p_allowed then
    if char_length(v_note) < 20 then
      return jsonb_build_object('ok', false,
        'error', 'a funding/collection policy note of at least 20 characters is required');
    end if;
    update public.printify_settings
       set cod_fulfilment_allowed = true,
           cod_policy_note = v_note,
           cod_policy_by = v_uid,
           cod_policy_at = now(),
           updated_at = now()
     where id = 1;
  else
    update public.printify_settings
       set cod_fulfilment_allowed = false,
           updated_at = now()
     where id = 1;
  end if;

  return jsonb_build_object('ok', true, 'cod_fulfilment_allowed', p_allowed, 'note', v_note);
end $$;

comment on function public.set_printify_cod_policy(boolean, text) is
  'Records an admin-authorised off-platform funding/collection arrangement. Does not imply Printify collects cash.';

-- ---------------------------------------------------------------------------
-- 10. The claim — eligibility + duplicate-submission protection
-- ---------------------------------------------------------------------------
-- Called with the ADMIN'S OWN JWT (not the service role) so is_admin() has a
-- uid to check. Two concurrent claims cannot both succeed: the row is taken
-- with FOR UPDATE, so the second caller blocks, then re-reads state =
-- 'submitting' with an unexpired token and is refused.
--
-- Eligibility, in order:
--   enabled must be on, shop + token must exist
--   order must exist and not be Cancelled
--   bank transfer  -> payment_status must be 'Paid'
--   cash on delivery -> cod_fulfilment_allowed must be true
--   at least one line must resolve through printify_variant_map with an
--   'imported' product
--
-- Returns the exact line set to submit. Lines that do not map are simply not
-- returned: they stay on the existing order untouched.
create or replace function public.claim_printify_fulfilment(p_order_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid        uuid := auth.uid();
  v_settings   public.printify_settings;
  v_has_token  boolean;
  v_order      public.orders%rowtype;
  v_ful        public.order_fulfilment%rowtype;
  v_lines      jsonb;
  v_count      integer;
  v_token      uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'not authorised');
  end if;

  select * into v_settings from public.printify_settings where id = 1;
  if v_settings.id is null or not v_settings.enabled then
    return jsonb_build_object('ok', false, 'error', 'printify fulfilment is disabled');
  end if;
  if coalesce(v_settings.shop_id, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'no printify shop selected');
  end if;
  select exists (select 1 from public.printify_credentials where id = 1) into v_has_token;
  if not v_has_token then
    return jsonb_build_object('ok', false, 'error', 'no printify credentials saved');
  end if;

  -- Lock the order, then the fulfilment row. Consistent order avoids deadlock.
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    return jsonb_build_object('ok', false, 'error', 'order not found');
  end if;
  if v_order.status = 'Cancelled' then
    return jsonb_build_object('ok', false, 'error', 'order is cancelled');
  end if;

  insert into public.order_fulfilment (order_id) values (p_order_id)
    on conflict (order_id) do nothing;
  -- Blocks here until the concurrent claimer commits or rolls back.
  select * into v_ful from public.order_fulfilment where order_id = p_order_id for update;

  if v_ful.state in ('submitted','fulfilled','partially_fulfilled') then
    return jsonb_build_object('ok', false, 'error', 'already submitted',
      'printify_order_id', v_ful.printify_order_id, 'state', v_ful.state);
  end if;
  if v_ful.state = 'submitting' then
    if v_ful.claim_expires_at is not null and v_ful.claim_expires_at > now() then
      return jsonb_build_object('ok', false, 'error', 'another submission is in flight',
        'state', v_ful.state);
    end if;
    -- Expired claim: the previous worker died. Reclaiming is safe because the
    -- Printify external_id is the order id, so a replay returns 409 and is
    -- reconciled rather than producing a second production order.
  end if;

  -- Payment gate.
  if v_order.payment = 'bank' and v_order.payment_status <> 'Paid' then
    update public.order_fulfilment
       set state = 'awaiting_payment', last_error = 'bank transfer not yet approved',
           claim_token = null, claim_expires_at = null, updated_at = now()
     where order_id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'bank transfer awaiting payment approval',
      'state', 'awaiting_payment');
  end if;
  if v_order.payment = 'cod' and not v_settings.cod_fulfilment_allowed then
    update public.order_fulfilment
       set state = 'manual_review', last_error = 'cash on delivery fulfilment has no approved funding policy',
           claim_token = null, claim_expires_at = null, updated_at = now()
     where order_id = p_order_id;
    return jsonb_build_object('ok', false, 'error',
      'cash on delivery needs an approved funding/collection policy note', 'state', 'manual_review');
  end if;

  -- Resolve this order's Printify-managed lines from the TRUSTED stored maps.
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_index',          l.idx,
           'website_product_id',  l.pid,
           'name',                l.name,
           'size',                l.size,
           'colour',              l.colour,
           'quantity',            l.qty,
           'external_product_id', l.external_product_id,
           'printify_variant_id', l.printify_variant_id,
           'line_external_id',    p_order_id || ':' || l.idx::text,
           'cost_cents',          l.cost_cents
         ) order by l.idx), '[]'::jsonb)
     into v_lines
    from (
      select
        (ordinality - 1)::int                              as idx,
        coalesce(item ->> 'productId', '')                  as pid,
        coalesce(item ->> 'name', '')                       as name,
        coalesce(item ->> 'size', '')                       as size,
        coalesce(item ->> 'colour', '')                     as colour,
        greatest(coalesce((item ->> 'qty')::int, 0), 1)     as qty,
        pp.external_product_id,
        vm.printify_variant_id,
        vm.cost_cents
      from public.orders o,
           jsonb_array_elements(o.items) with ordinality as t(item, ordinality)
      join public.products wp on wp.id = (item ->> 'productId')
      join public.printify_products pp on pp.product_id = wp.id and pp.status = 'imported'
      join public.printify_variant_map vm
        on vm.external_product_id = pp.external_product_id
       and vm.size   = btrim(coalesce(item ->> 'size', ''))
       -- Both axes must match. Matching on size alone once let a line for a
       -- colour that has no mapped variant be produced as the nearest colour
       -- that does — the exact "sold incorrectly" failure this table exists to
       -- prevent, so colour is part of the join key, not a filter after it.
       and vm.colour = btrim(coalesce(item ->> 'colour', ''))
       and vm.available
      where o.id = p_order_id
    ) l;

  select count(*) into v_count from jsonb_array_elements(v_lines);
  if v_count = 0 then
    update public.order_fulfilment
       set state = 'not_eligible', last_error = 'no line matches an imported printify product',
           claim_token = null, claim_expires_at = null, updated_at = now()
     where order_id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'no printify-managed lines',
      'state', 'not_eligible');
  end if;

  delete from public.order_fulfilment_lines where order_id = p_order_id;
  insert into public.order_fulfilment_lines
    (order_id, line_index, website_product_id, name, size, colour, quantity,
     external_product_id, printify_variant_id, line_external_id, claim_token)
  select p_order_id,
         (l ->> 'line_index')::int,
         l ->> 'website_product_id', l ->> 'name',
         l ->> 'size', l ->> 'colour', (l ->> 'quantity')::int,
         l ->> 'external_product_id', (l ->> 'printify_variant_id')::int,
         l ->> 'line_external_id', v_token
    from jsonb_array_elements(v_lines) l;

  update public.order_fulfilment
     set state = 'submitting',
         claim_token = v_token,
         claim_expires_at = now() + interval '4 minutes',
         attempts = attempts + 1,
         last_error = null,
         updated_at = now()
   where order_id = p_order_id;

  return jsonb_build_object(
    'ok', true,
    'claim_token', v_token,
    'order_id', p_order_id,
    'shop_id', v_settings.shop_id,
    'external_id', p_order_id,
    'lines', v_lines,
    'line_count', v_count,
    'total_quantity', (select coalesce(sum((l ->> 'quantity')::int), 0) from jsonb_array_elements(v_lines) l),
    'send_to_production', v_settings.auto_send_to_production
  );
end $$;

comment on function public.claim_printify_fulfilment(text) is
  'Atomic eligibility check + claim. Row-locked, admin-only, blocks simultaneous duplicate submissions.';

-- ---------------------------------------------------------------------------
-- 11. Release the claim with the outcome
-- ---------------------------------------------------------------------------
-- The token must still match the row, so a worker that lost its claim (its
-- expiry passed and someone else reclaimed) can never overwrite the newer
-- attempt with a stale failure or a stale order id.
create or replace function public.release_printify_fulfilment(
  p_order_id text,
  p_claim_token uuid,
  p_succeeded boolean,
  p_printify_order_id text default null,
  p_error text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_current public.order_fulfilment%rowtype;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'not authorised');
  end if;

  select * into v_current from public.order_fulfilment where order_id = p_order_id for update;
  if v_current.order_id is null then
    return jsonb_build_object('ok', false, 'error', 'no fulfilment row');
  end if;
  if v_current.claim_token is distinct from p_claim_token then
    return jsonb_build_object('ok', false, 'error', 'claim no longer valid',
      'state', v_current.state);
  end if;

  if p_succeeded then
    update public.order_fulfilment
       set state = case when v_current.state = 'partially_fulfilled' then state else 'submitted' end,
           printify_order_id = coalesce(p_printify_order_id, printify_order_id),
           last_error = null,
           submitted_at = coalesce(submitted_at, now()),
           claim_token = null,
           claim_expires_at = null,
           updated_at = now()
     where order_id = p_order_id;
  else
    update public.order_fulfilment
       set state = 'failed',
           last_error = left(coalesce(p_error, 'unknown error'), 500),
           claim_token = null,
           claim_expires_at = null,
           updated_at = now()
     where order_id = p_order_id;
  end if;

  return jsonb_build_object('ok', true,
    'state', (select state from public.order_fulfilment where order_id = p_order_id));
end $$;

-- ---------------------------------------------------------------------------
-- 12. Webhook ingestion — service_role only (no user session exists)
-- ---------------------------------------------------------------------------
-- Dedup on the event id primary key: 'inserted' false means Printify retried
-- this delivery, and the caller must not apply the effect a second time.
create or replace function public.record_printify_event(
  p_event_id uuid,
  p_topic text,
  p_resource_type text,
  p_resource_id text,
  p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows integer;
begin
  insert into public.printify_webhook_events
    (event_id, topic, resource_type, resource_id, payload)
    values (p_event_id, p_topic, p_resource_type, p_resource_id, coalesce(p_payload, '{}'))
    on conflict (event_id) do nothing;
  -- ROW_COUNT is 0 when the ON CONFLICT arbiter swallowed the insert, i.e.
  -- Printify is retrying a delivery we have already applied.
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false);
end $$;

create or replace function public.mark_printify_event(
  p_event_id uuid,
  p_status text,
  p_error text default null
) returns void
language sql security definer set search_path = public as $$
  update public.printify_webhook_events
     set status = case when p_status in ('received','processed','ignored','failed')
                       then p_status else 'processed' end,
         error = left(coalesce(p_error, ''), 500),
         processed_at = now()
   where event_id = p_event_id;
$$;

-- The ONLY path that touches the customer timeline. Appends 'Shipped' or
-- 'Delivered' from a verified shipment event, forwards-only, and never on a
-- cancelled or already-delivered order. Carrier + tracking go to their own
-- table so the storefront timeline stays exactly as simple as it was.
create or replace function public.apply_printify_shipment(
  p_event_id uuid,
  p_order_id text,
  p_status text,               -- 'shipped' | 'delivered'
  p_carrier text,
  p_tracking_number text,
  p_tracking_url text,
  p_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders%rowtype;
  v_target text;
begin
  if p_status = 'shipped'  then v_target := 'Shipped';
  elsif p_status = 'delivered' then v_target := 'Delivered';
  else return jsonb_build_object('ok', false, 'error', 'status must be shipped or delivered');
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    return jsonb_build_object('ok', false, 'error', 'order not found');
  end if;
  if v_order.status = 'Cancelled' then
    return jsonb_build_object('ok', true, 'ignored', 'order cancelled');
  end if;

  -- Forwards-only: never move a customer timeline backwards and never add a
  -- status the order has already passed.
  if v_target = 'Shipped'
     and v_order.status in ('Shipped','Out for delivery','Delivered') then
    insert into public.printify_shipments
      (order_id, event_id, carrier, tracking_number, tracking_url, shipped_at)
      values (p_order_id, p_event_id, p_carrier, p_tracking_number, p_tracking_url, p_at)
      on conflict do nothing;
    return jsonb_build_object('ok', true, 'ignored', 'already shipped', 'tracking_stored', true);
  end if;
  if v_target = 'Delivered' and v_order.status = 'Delivered' then
    return jsonb_build_object('ok', true, 'ignored', 'already delivered');
  end if;

  insert into public.printify_shipments
    (order_id, event_id, carrier, tracking_number, tracking_url, shipped_at, delivered_at)
    values (p_order_id, p_event_id, p_carrier, p_tracking_number, p_tracking_url,
            case when v_target = 'Shipped' then p_at else null end,
            case when v_target = 'Delivered' then p_at else null end)
    on conflict do nothing;

  update public.orders
     set status = v_target,
         timeline = coalesce(timeline, '[]'::jsonb)
                   || jsonb_build_array(jsonb_build_object('status', v_target, 'at', p_at))
   where id = p_order_id;

  update public.order_fulfilment
     set state = case when v_target = 'Delivered' then 'fulfilled' else state end,
         printify_status = case when v_target = 'Delivered' then 'delivered' else 'in_transit' end,
         updated_at = now()
   where order_id = p_order_id;

  return jsonb_build_object('ok', true, 'status', v_target, 'order_id', p_order_id);
end $$;

-- ---------------------------------------------------------------------------
-- 13. Fulfilment status mirror from verified order:updated events
-- ---------------------------------------------------------------------------
-- Records Printify's own lowercase status string. Deliberately does not touch
-- orders.status — an 'in-production' status is not 'Packed'.
create or replace function public.record_printify_order_status(
  p_order_id text,
  p_printify_order_id text,
  p_status text
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.order_fulfilment
     set printify_status = p_status,
         printify_order_id = coalesce(printify_order_id, nullif(p_printify_order_id, '')),
         state = case
           when p_status = 'canceled' then 'cancelled'
           when state = 'submitting' and p_status in ('pending','on-hold') then state
           else state end,
         updated_at = now()
   where order_id = p_order_id or printify_order_id = p_printify_order_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 14. Grants: claim/release = authenticated + admin-checked inside;
--     event ingestion = service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.claim_printify_fulfilment(text)                      from public, anon;
revoke all on function public.release_printify_fulfilment(text, uuid, boolean, text, text) from public, anon;
revoke all on function public.set_printify_cod_policy(boolean, text)               from public, anon;
revoke all on function public.record_printify_event(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.mark_printify_event(uuid, text, text)                from public, anon, authenticated;
revoke all on function public.apply_printify_shipment(uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_printify_order_status(text, text, text)       from public, anon, authenticated;

grant execute on function public.claim_printify_fulfilment(text) to authenticated, service_role;
grant execute on function public.release_printify_fulfilment(text, uuid, boolean, text, text) to authenticated, service_role;
grant execute on function public.set_printify_cod_policy(boolean, text) to authenticated, service_role;
grant execute on function public.record_printify_event(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.mark_printify_event(uuid, text, text) to service_role;
grant execute on function public.apply_printify_shipment(uuid, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.record_printify_order_status(text, text, text) to service_role;
