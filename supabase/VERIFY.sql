-- HUDA GYMWEAR — production health check (read-only, safe to run anytime)
-- Run in Supabase Dashboard → SQL Editor. Every row should read OK=true.
-- If any row reads false, apply the fix noted beside it, then re-run.

-- 1. anon can execute is_admin() — REQUIRED for guest checkout.
--    Guest inserts fire recalculate_order(), which reads products/discounts
--    whose RLS calls is_admin(). Without this grant every guest order fails
--    with "permission denied for function is_admin".
--    FIX: run supabase/migrations/0005_fix.sql
select 'anon is_admin execute' as check_name,
  has_function_privilege('anon', 'public.is_admin()', 'execute') as ok;

-- 2. authenticated keeps is_admin() (signed-in flows + admin panel).
select 'authenticated is_admin execute' as check_name,
  has_function_privilege('authenticated', 'public.is_admin()', 'execute') as ok;

-- 3. Server-side pricing trigger is attached to orders.
--    FIX: run supabase/migrations/0004_production.sql
select 'recalculate_order trigger' as check_name,
  exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relname = 'orders' and t.tgname = 'trg_recalculate_order'
  ) as ok;

-- 4. Restock-on-cancel trigger is attached to orders.
select 'restock_on_cancel trigger' as check_name,
  exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relname = 'orders' and t.tgname = 'trg_restock_on_cancel'
  ) as ok;

-- 5. Guest RPCs are executable by anon (tracking + receipts).
select 'anon guest RPCs' as check_name,
  has_function_privilege('anon', 'public.get_guest_order(text, text)', 'execute')
  and has_function_privilege('anon', 'public.attach_proof(text, text, text)', 'execute') as ok;

-- 6. order INSERT policy exists for guests (user_id IS NULL branch).
select 'orders guest insert policy' as check_name,
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'orders'
      and policyname = 'orders_insert' and cmd = 'INSERT'
  ) as ok;

-- 6b. Show the ACTUAL policy definition — compare with the repo files.
--     If this text differs, an old migration version is live: re-run
--     0003_security.sql (policies section) to align it.
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'orders';

-- 6c. Structural columns the app depends on (missing = migration not applied).
select 'products table' as check_name,
  exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'products') as ok;
select 'settings.categories column' as check_name,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'shop_settings' and column_name = 'categories') as ok;
select 'orders.transfer_proof_url column' as check_name,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'transfer_proof_url') as ok;

-- 7. Storage buckets exist (product images + transfer receipts).
select 'storage buckets' as check_name,
  exists (select 1 from storage.buckets where id = 'product-images')
  and exists (select 1 from storage.buckets where id = 'transfer-proofs') as ok;

-- 8. No direct-call grants left on internal trigger helpers.
select 'helpers locked down' as check_name,
  not has_function_privilege('anon', 'public.recalculate_order()', 'execute')
  and not has_function_privilege('anon', 'public.restock_on_cancel()', 'execute') as ok;
