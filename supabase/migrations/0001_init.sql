-- HUDA GYMWEAR — initial backend schema (Supabase/Postgres)
-- Run once in the Supabase SQL editor (or `supabase db push`).

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  name text not null default '',
  role text not null default 'customer' check (role in ('customer','admin')),
  tags text[] not null default '{}',
  notes jsonb not null default '[]',
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Auto-create a profile row on every signup (name from user_metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'name', ''));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- A user reads/updates only their own profile. Admins read all.
create policy "profiles_owner_read" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_owner_insert" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_owner_update" on public.profiles
  for update using (auth.uid() = id);
create policy "profiles_owner_delete" on public.profiles
  for delete using (auth.uid() = id);
create policy "profiles_admin_all" on public.profiles
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- ---------------------------------------------------------------- addresses
create table if not exists public.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  label text not null default '',
  first_name text not null default '',
  last_name text not null default '',
  street text not null default '',
  city text not null default '',
  postcode text not null default '',
  country text not null default '',
  phone text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.addresses enable row level security;
create policy "addresses_owner_all" on public.addresses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "addresses_admin_read" on public.addresses
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- ---------------------------------------------------------------- orders
create table if not exists public.orders (
  id text primary key,
  user_id uuid references public.profiles (id) on delete set null,
  guest_email text not null default '',
  customer text not null default '',
  address jsonb not null default '{}',
  items jsonb not null default '[]',
  subtotal numeric not null default 0,
  discount numeric not null default 0,
  discount_code text,
  shipping jsonb not null default '{}',
  total numeric not null default 0,
  payment text not null default 'cod',
  payment_status text not null default 'Cash on delivery',
  transfer_ref text,
  client_key text unique,
  status text not null default 'Order received',
  timeline jsonb not null default '[]',
  created_at timestamptz not null default now()
);
alter table public.orders enable row level security;
-- Owner sees own orders (by user_id, or legacy guest email match via JWT claim —
-- anon/authenticated roles cannot read auth.users, so use the JWT email).
create policy "orders_owner_read" on public.orders
  for select using (
    auth.uid() = user_id
    or lower(guest_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
-- Checkout creates orders as the signed-in user (or guest: user_id null).
create policy "orders_insert" on public.orders
  for insert with check (
    user_id is null
    or auth.uid() = user_id
    or lower(guest_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
create policy "orders_admin_all" on public.orders
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- Claim guest orders after signup/login with the same email.
create or replace function public.claim_guest_orders()
returns void language plpgsql security definer set search_path = public as $$
declare
  my_email text;
begin
  select email into my_email from auth.users where id = auth.uid();
  if my_email is null then return; end if;
  update public.orders
    set user_id = auth.uid()
    where user_id is null and lower(guest_email) = lower(my_email);
end $$;

-- ---------------------------------------------------------------- wishlist
create table if not exists public.wishlist (
  user_id uuid not null references public.profiles (id) on delete cascade,
  product_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);
alter table public.wishlist enable row level security;
create policy "wishlist_owner_all" on public.wishlist
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "wishlist_admin_read" on public.wishlist
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- ---------------------------------------------------------------- reviews
create table if not exists public.reviews (
  id text primary key,
  product_id text not null,
  user_id uuid references public.profiles (id) on delete set null,
  author text not null default '',
  email text not null default '',
  rating int not null check (rating between 1 and 5),
  title text not null default '',
  body text not null default '',
  size text not null default '',
  verified boolean not null default false,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_reply text,
  helpful int not null default 0,
  seed boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.reviews enable row level security;
-- Everyone (incl. guests) reads approved reviews; owners read their own.
create policy "reviews_public_read" on public.reviews
  for select using (status = 'approved' or auth.uid() = user_id);
create policy "reviews_owner_insert" on public.reviews
  for insert with check (auth.uid() = user_id);
create policy "reviews_owner_update_own" on public.reviews
  for update using (auth.uid() = user_id);
create policy "reviews_admin_all" on public.reviews
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- ---------------------------------------------------------------- bootstrap
-- FIRST ADMIN (run once in the SQL editor after your own signup):
--   update public.profiles set role = 'admin' where email = 'you@example.co.uk';
-- The signup trigger always creates role='customer'; only a SQL editor (or an
-- existing admin) can promote the first admin — never the storefront.
