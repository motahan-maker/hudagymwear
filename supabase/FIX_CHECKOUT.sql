-- HUDA GYMWEAR — one-shot guest-checkout repair
-- Run ONCE in Supabase Dashboard → SQL Editor → New query → paste all → Run.
-- Safe to re-run (every statement is idempotent). Fixes, in order:
--   1. "permission denied for function is_admin" (anon missing EXECUTE)
--   2. "new row violates RLS for table orders" (stale/missing insert policy)
--   3. "column shop_settings.categories does not exist" (0006 column missing)

-- ---------------------------------------------------------------- 1. grants
-- The pricing trigger reads products/discounts whose RLS calls is_admin().
-- For anon that function can only ever return false, so granting EXECUTE
-- changes nothing security-wise — it just lets the policy evaluate.
grant execute on function public.is_admin() to anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------- 2. categories column
alter table if exists public.shop_settings
  add column if not exists categories jsonb default '[
    {"name": "Leggings", "visible": true, "order": 0},
    {"name": "Sports Bras", "visible": true, "order": 1},
    {"name": "Matching Sets", "visible": true, "order": 2},
    {"name": "Hoodies", "visible": true, "order": 3},
    {"name": "Tops & T-Shirts", "visible": true, "order": 4},
    {"name": "Shorts", "visible": true, "order": 5},
    {"name": "Jackets", "visible": true, "order": 6},
    {"name": "Accessories", "visible": true, "order": 7}
  ]'::jsonb;

-- ---------------------------------------------------------------- 3. canonical orders policies
-- Drops whatever version is live (including pre-fix variants) and recreates
-- the canonical definitions. RLS itself stays ON the whole time.
drop policy if exists "orders_owner_read" on public.orders;
drop policy if exists "orders_insert" on public.orders;
drop policy if exists "orders_admin_all" on public.orders;

create policy "orders_owner_read" on public.orders
  for select using (
    auth.uid() = user_id
    or (
      guest_email <> ''
      and coalesce(auth.jwt() ->> 'email', '') <> ''
      and lower(guest_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );
create policy "orders_insert" on public.orders
  for insert with check (
    user_id is null
    or auth.uid() = user_id
    or (
      guest_email <> ''
      and coalesce(auth.jwt() ->> 'email', '') <> ''
      and lower(guest_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );
create policy "orders_admin_all" on public.orders
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- 4. self-check
-- Send these four results back. All four must read true.
select 'anon is_admin execute' as check_name,
  has_function_privilege('anon', 'public.is_admin()', 'execute') as ok;
select 'settings.categories column' as check_name,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'shop_settings' and column_name = 'categories') as ok;
select 'orders_insert policy' as check_name,
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders' and policyname = 'orders_insert' and cmd = 'INSERT') as ok;
select 'pricing trigger' as check_name,
  exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relname = 'orders' and t.tgname = 'trg_recalculate_order') as ok;
