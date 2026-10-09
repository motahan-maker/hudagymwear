-- 0008_remove_shopper_accounts.sql
-- HUDA GYMWEAR — remove shopper-account backend objects (shopper auth deleted)
--
-- WHAT WAS REMOVED AND WHY:
--   Shopper accounts are deleted from the product: no signup/login, no saved
--   addresses, no server-side guest-order claiming. The storefront is now
--   guest-only (plus local-only wishlist in the browser). This migration
--   removes the backend objects that only existed for shoppers:
--     1. Signup auto-provisioning: trigger `on_auth_user_created` on
--        auth.users + function public.handle_new_user().
--     2. Saved addresses: table public.addresses (CASCADE drops its RLS
--        policies addresses_owner_all / addresses_admin_all with it).
--     3. Guest-order claiming: function public.claim_guest_orders().
--     4. Customer self-write RLS policies on profiles (insert/update/delete,
--        plus owner_read — no shoppers remain, so no self-service reads):
--          profiles_owner_read / profiles_owner_insert /
--          profiles_owner_update / profiles_owner_delete.
--     5. Realtime replication entry for profiles (0006 added it; staff admin
--        UI does not need it). Orders/products/etc realtime untouched.
--
-- WHAT STAYS (staff auth mechanism):
--   public.profiles + role='admin' REMAINS the staff auth mechanism, enforced
--   via public.is_admin() and policy profiles_admin_all, plus the
--   block_privilege_escalation trigger (trg_block_escalation), which still
--   protects role/tags/notes. Admins are promoted via SQL / existing admin
--   only — never from the storefront.
--
-- WHAT IS INTENTIONALLY NOT TOUCHED:
--   - public.profiles table, profiles_admin_all policy, is_admin(),
--     block_privilege_escalation()/trg_block_escalation.
--   - public.wishlist table + its policies (kept dormant; wishlist is now
--     local-only in the browser, table stays for history/compat).
--   - orders table/policies/triggers (recalculate_order, restock_on_cancel),
--     reviews table (another worker rewrites its insert policy),
--     products / shop_settings / discounts / messages, storage buckets +
--     their policies, vote_helpful(), get_guest_order(), attach_proof().
--   - No new GRANTs for claim_guest_orders(): old migrations' grants already
--     applied and vanish with the DROP; nothing re-added here.
--
-- All statements are re-runnable (IF EXISTS / DROP IF EXISTS + guarded
-- publication block). Does NOT edit any prior migration file.

-- ---------------------------------------------------------------- 1. signup trigger + function
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- ---------------------------------------------------------------- 2. addresses table (policies drop with it via CASCADE)
drop table if exists public.addresses cascade;

-- ---------------------------------------------------------------- 3. guest-order claim RPC
drop function if exists public.claim_guest_orders();

-- ---------------------------------------------------------------- 4. customer self-service policies on profiles
-- KEEPS: profiles table, profiles_admin_all, trg_block_escalation.
drop policy if exists "profiles_owner_read" on public.profiles;
drop policy if exists "profiles_owner_insert" on public.profiles;
drop policy if exists "profiles_owner_update" on public.profiles;
drop policy if exists "profiles_owner_delete" on public.profiles;

-- ---------------------------------------------------------------- 5. wishlist: INTENTIONALLY UNTOUCHED (dormant, local-only)
-- Table public.wishlist + policies wishlist_owner_all / wishlist_admin_all stay.

-- ---------------------------------------------------------------- 6. realtime: drop profiles ONLY, keep the rest
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'profiles'
    ) then
      begin
        alter publication supabase_realtime drop table public.profiles;
      exception when undefined_object then null;
      end;
    end if;
  end if;
end $$;
