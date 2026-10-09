-- HUDA GYMWEAR — product image storage (Supabase Storage)
-- Run once in the Supabase SQL editor AFTER 0001_init.sql.
-- Creates a PUBLIC bucket `product-images`: anyone can view images,
-- only signed-in admins (profiles.role = 'admin') can upload or delete.

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Drop-then-create so the migration is safely re-runnable.
drop policy if exists "product_images_public_read" on storage.objects;
drop policy if exists "product_images_admin_insert" on storage.objects;
drop policy if exists "product_images_admin_update" on storage.objects;
drop policy if exists "product_images_admin_delete" on storage.objects;

-- Public read (storefront <img> tags, no login needed).
create policy "product_images_public_read"
on storage.objects for select
using (bucket_id = 'product-images');

-- Admin write: insert / update / delete limited to admins.
create policy "product_images_admin_insert"
on storage.objects for insert
with check (
  bucket_id = 'product-images'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);
create policy "product_images_admin_update"
on storage.objects for update
using (
  bucket_id = 'product-images'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);
create policy "product_images_admin_delete"
on storage.objects for delete
using (
  bucket_id = 'product-images'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);
