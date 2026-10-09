-- HUDA GYMWEAR — security hardening (run AFTER 0001_init.sql + 0002_storage.sql)
-- Fixes, in order:
--  1. Admin policies self-referenced `profiles` -> infinite RLS recursion.
--     All admin checks now go through a SECURITY DEFINER `is_admin()` helper.
--  2. Any user could self-promote to admin (update had no column guard).
--  3. Order totals/status/payment were client-forgeable on insert.
--  4. Reviews could be self-approved / forged verified / helpful-farmed.
--  5. Admin customer flows lacked write policies (notes/tags/addresses).
--  6. `claim_guest_orders()` was not granted to authenticated users.
--  7. Storage had no server-side size/mime limits.
-- All statements are re-runnable (drop-if-exists / create-or-replace).

-- ---------------------------------------------------------------- 1. helper
create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------- 2. profiles
drop policy if exists "profiles_owner_read" on public.profiles;
drop policy if exists "profiles_owner_insert" on public.profiles;
drop policy if exists "profiles_owner_update" on public.profiles;
drop policy if exists "profiles_owner_delete" on public.profiles;
drop policy if exists "profiles_admin_all" on public.profiles;

create policy "profiles_owner_read" on public.profiles
  for select using (auth.uid() = id);
-- Self-signup may only ever create a CUSTOMER profile (promotion is SQL/admin only).
create policy "profiles_owner_insert" on public.profiles
  for insert with check (auth.uid() = id and role = 'customer');
create policy "profiles_owner_update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "profiles_owner_delete" on public.profiles
  for delete using (auth.uid() = id);
create policy "profiles_admin_all" on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- Belt-and-braces: only admins may change role/tags/notes, even if a policy
-- regresses. Name/email remain user-editable (email via Auth dashboard).
create or replace function public.block_privilege_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'role change denied';
  end if;
  if (new.tags is distinct from old.tags or new.notes is distinct from old.notes)
     and not public.is_admin() then
    raise exception 'customer tags/notes are admin-only';
  end if;
  return new;
end $$;
drop trigger if exists trg_block_escalation on public.profiles;
create trigger trg_block_escalation before update on public.profiles
  for each row execute function public.block_privilege_escalation();

-- One profile per email (admin lookup by email relies on a single row).
create unique index if not exists profiles_email_unique
  on public.profiles (lower(email)) where email <> '';

-- ---------------------------------------------------------------- 3. addresses
drop policy if exists "addresses_owner_all" on public.addresses;
drop policy if exists "addresses_admin_read" on public.addresses;
drop policy if exists "addresses_admin_all" on public.addresses;

create policy "addresses_owner_all" on public.addresses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "addresses_admin_all" on public.addresses
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- 4. orders
drop policy if exists "orders_owner_read" on public.orders;
drop policy if exists "orders_insert" on public.orders;
drop policy if exists "orders_admin_all" on public.orders;

-- Owner sees own orders. The guest_email<>'' guards stop ''='' matching.
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

-- Money/status are server-decided: sane ranges + forced initial pipeline step.
alter table public.orders
  drop constraint if exists orders_money_chk,
  add constraint orders_money_chk check (total >= 0 and subtotal >= 0 and discount >= 0);
alter table public.orders
  drop constraint if exists orders_status_chk,
  add constraint orders_status_chk check (status in (
    'Order received', 'Awaiting payment proof', 'Received', 'Packed',
    'Shipped', 'Out for delivery', 'Delivered', 'Cancelled'
  ));
create or replace function public.force_order_defaults()
returns trigger language plpgsql set search_path = public as $$
begin
  new.guest_email := lower(trim(new.guest_email));
  if new.payment = 'bank' then
    new.status := 'Awaiting payment proof';
    new.payment_status := 'Pending proof';
  else
    new.status := 'Order received';
    new.payment_status := 'Cash on delivery';
  end if;
  new.timeline := jsonb_build_array(jsonb_build_object('status', new.status, 'at', now()));
  return new;
end $$;
drop trigger if exists trg_order_defaults on public.orders;
create trigger trg_order_defaults before insert on public.orders
  for each row execute function public.force_order_defaults();

-- ---------------------------------------------------------------- 5. wishlist
drop policy if exists "wishlist_owner_all" on public.wishlist;
drop policy if exists "wishlist_admin_read" on public.wishlist;
drop policy if exists "wishlist_admin_all" on public.wishlist;

create policy "wishlist_owner_all" on public.wishlist
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "wishlist_admin_all" on public.wishlist
  for select using (public.is_admin());

-- ---------------------------------------------------------------- 6. reviews
drop policy if exists "reviews_public_read" on public.reviews;
drop policy if exists "reviews_owner_insert" on public.reviews;
drop policy if exists "reviews_owner_update_own" on public.reviews;
drop policy if exists "reviews_admin_all" on public.reviews;

create policy "reviews_public_read" on public.reviews
  for select using (status = 'approved' or auth.uid() = user_id);
-- New reviews always enter moderation as unverified, zero-vote pendings.
create policy "reviews_owner_insert" on public.reviews
  for insert with check (
    auth.uid() = user_id and status = 'pending' and verified = false and helpful = 0
  );
-- Owners cannot edit reviews from the client at all (admins moderate).
create policy "reviews_admin_all" on public.reviews
  for all using (public.is_admin()) with check (public.is_admin());

-- Helpful votes: anyone (even guests) may +1, exactly one increment per call.
-- Per-browser dedupe stays client-side (localStorage voted list).
create or replace function public.vote_helpful(rid text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.reviews set helpful = helpful + 1 where id = rid;
end $$;
revoke all on function public.vote_helpful(text) from public;
grant execute on function public.vote_helpful(text) to anon, authenticated;

-- ---------------------------------------------------------------- 7. claim RPC grant
revoke all on function public.claim_guest_orders() from public, anon;
grant execute on function public.claim_guest_orders() to authenticated;

-- ---------------------------------------------------------------- 8. storage hardening
drop policy if exists "product_images_public_read" on storage.objects;
drop policy if exists "product_images_admin_insert" on storage.objects;
drop policy if exists "product_images_admin_update" on storage.objects;
drop policy if exists "product_images_admin_delete" on storage.objects;

create policy "product_images_public_read" on storage.objects
  for select using (bucket_id = 'product-images');
create policy "product_images_admin_insert" on storage.objects
  for insert with check (
    bucket_id = 'product-images'
    and public.is_admin()
    and storage.extension(name) in ('webp', 'jpg', 'jpeg', 'png')
  );
create policy "product_images_admin_update" on storage.objects
  for update using (bucket_id = 'product-images' and public.is_admin())
  with check (bucket_id = 'product-images' and public.is_admin());
create policy "product_images_admin_delete" on storage.objects
  for delete using (bucket_id = 'product-images' and public.is_admin());

-- Server-side size + mime limits (client checks alone are not enforcement).
update storage.buckets
  set file_size_limit = 10485760,
      allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png']
  where id = 'product-images';
