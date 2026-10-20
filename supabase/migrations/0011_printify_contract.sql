-- 0011_printify_contract.sql
--
-- PURPOSE
--   Make the Printify mirror match the shape the Printify API actually
--   returns, and record the facts the admin screen needs to be honest.
--
-- WHY
--   1. A shop product's variant carries OPTION IDS (`options: [1189, 1191]`).
--      The labels — and, crucially, which axis each option belongs to — live
--      on the parent product (`options: [{name:'Sizes', type:'size',
--      values:[{id:1189,title:'XS'}]}]`). The mirror kept neither, so the
--      variant mapper could not tell a size from a colour and every variant
--      was reported as unmapped: fulfilment could never have worked.
--   2. `product.images` is a list of OBJECTS
--      (`{src, variant_ids, position, is_default}`), not a list of URL
--      strings. Read as strings it produced an empty catalogue, so no
--      production mockup ever reached the storefront.
--   3. The production cost's currency was assumed to be GBP. The API does not
--      say so, and the catalog's own shipping profiles are denominated in USD.
--      The currency is now a recorded fact rather than an assumption, and the
--      admin screen shows no margin until it has been confirmed live.
--   4. A Personal Access Token is valid for one year and then stops working.
--      Its expiry is recorded so the admin can be warned before it does.
--   5. The webhook receiver looks up an order by `printify_order_id`, and
--      there was no index on it, so every delivery scanned the table.
--   6. A mapping an admin reviewed by hand is a decision, not a derived
--      value, and a re-sync must not quietly replace it.
--
-- DATA IMPACT
--   Additive only. No rows are deleted and no existing value is changed.
--   `printify_variant_map.source` defaults to 'auto' for the rows already
--   there, which is correct: they were all produced by the mapper.
--   The next catalogue sync fills `options`, `image_urls` and `cost_currency`
--   in; until then they are empty, and the mapper reports the affected
--   variants for review rather than guessing.
--
-- PRECONDITIONS
--   0010_printify.sql must have been applied.
--
-- RISKS
--   None for the schema itself. The new columns stay unused until the Edge
--   Functions that read them are deployed, and those functions tolerate the
--   new columns being empty.
--
-- ROLLBACK
--   The columns and the table can be dropped again, and the Edge Functions
--   fall back to their previous behaviour. Dropping
--   `printify_variant_map.source` is only safe once no manual mapping exists.
--
-- Re-runnable: every statement is guarded.

-- ---------------------------------------------------------------------------
-- 1. The option definitions the variant ids refer to
-- ---------------------------------------------------------------------------
alter table public.printify_products
  add column if not exists options jsonb not null default '[]'::jsonb;

comment on column public.printify_products.options is
  'The parent product''s option definitions ({name,type,values[]}). A variant carries only option ids, so these are what tell a size from a colour.';

-- ---------------------------------------------------------------------------
-- 2. Production mockups: the raw objects plus a flat list of their URLs
-- ---------------------------------------------------------------------------
alter table public.printify_products
  add column if not exists image_urls text[] not null default '{}'::text[];

comment on column public.printify_products.image_urls is
  'Flat list of the production mockup URLs. `images` holds the raw objects the API returns; this column is the convenience list the admin screen reads.';

-- ---------------------------------------------------------------------------
-- 3. The currency the production cost is actually in
-- ---------------------------------------------------------------------------
alter table public.printify_products
  add column if not exists cost_currency text not null default '';

comment on column public.printify_products.cost_currency is
  'Currency of cost_cents, as confirmed against the live API. Empty means NOT CONFIRMED — a margin must not be shown until it is.';

-- ---------------------------------------------------------------------------
-- 4. Manual mappings survive a re-sync
-- ---------------------------------------------------------------------------
alter table public.printify_variant_map
  add column if not exists source text not null default 'auto';

alter table public.printify_variant_map
  drop constraint if exists printify_variant_map_source_chk;
alter table public.printify_variant_map
  add constraint printify_variant_map_source_chk check (source in ('auto', 'manual'));

comment on column public.printify_variant_map.source is
  'auto = produced by the mapper; manual = reviewed and set by an admin. A re-sync replaces auto rows only.';

-- ---------------------------------------------------------------------------
-- 5. Token expiry
-- ---------------------------------------------------------------------------
alter table public.printify_credentials
  add column if not exists expires_at timestamptz;

alter table public.printify_credentials
  add column if not exists token_scopes text not null default '';

alter table public.printify_credentials
  add column if not exists last_verified_at timestamptz;

comment on column public.printify_credentials.expires_at is
  'When the Personal Access Token expires. Printify access tokens are valid for one year.';

-- ---------------------------------------------------------------------------
-- 6. Index the webhook receiver actually uses
-- ---------------------------------------------------------------------------
-- The receiver resolves a Printify order id to a store order through
-- order_fulfilment.printify_order_id. Without this index every delivery was
-- a full table scan.
create unique index if not exists order_fulfilment_printify_order_idx
  on public.order_fulfilment (printify_order_id)
  where printify_order_id is not null;

-- ---------------------------------------------------------------------------
-- 7. A log of the requests made to Printify
-- ---------------------------------------------------------------------------
-- The API contract caps error responses at 5% of total requests and limits
-- the account to 600 requests a minute. Without a record of what was sent
-- neither limit can be policed, and a silently failing sync looks the same
-- as a sync that had nothing to do.
create table if not exists public.printify_request_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  method      text not null default '',
  path        text not null default '',
  status      integer not null default 0,
  duration_ms integer not null default 0,
  error       boolean not null default false
);

create index if not exists printify_request_log_at_idx
  on public.printify_request_log (at desc);
create index if not exists printify_request_log_error_idx
  on public.printify_request_log (at desc) where error;

comment on table public.printify_request_log is
  'Every call made to Printify, so the documented rate and error-rate limits can be policed. Written by the Edge Function with the service role only.';

alter table public.printify_request_log enable row level security;

-- The log is written by the Edge Function with the service role and read by
-- an admin. No browser role may write to it.
drop policy if exists "printify_request_log_admin_read" on public.printify_request_log;
create policy "printify_request_log_admin_read" on public.printify_request_log
  for select using (public.is_admin());

revoke all on table public.printify_request_log from anon, authenticated;
grant select on table public.printify_request_log to authenticated;
grant all on table public.printify_request_log to service_role;
grant usage, select on sequence public.printify_request_log_id_seq to service_role;
