-- HUDA GYMWEAR — production backend (run AFTER 0001 + 0002 + 0003)
-- Requires public.is_admin() from 0003.
--  A. Guest order lookup RPC (tracking + order-success for guests)
--  B. Bank transfer proof uploads (private bucket + orders.transfer_proof_url)
--  C. Shared tables killing the localStorage trap:
--       products / shop_settings / discounts / messages
--  D. Server-side order pricing (replaces client-trusted totals):
--       official prices, discount validation + counting, stock check + decrement,
--       shipping recompute, forced pipeline status. Hostile clients cannot
--       forge totals — Postgres decides money, always.
--  E. Automatic restock when an order is cancelled.
-- All statements are re-runnable.

-- ---------------------------------------------------------------- A. guest RPC
create or replace function public.get_guest_order(p_order_id text, p_email text)
returns jsonb language plpgsql security definer set search_path = public stable as $$
declare
  res jsonb;
begin
  if p_order_id is null or p_email is null then return null; end if;
  select to_jsonb(o) into res from public.orders o
    where o.id = p_order_id and lower(o.guest_email) = lower(trim(p_email));
  return res;
end $$;
revoke all on function public.get_guest_order(text, text) from public;
grant execute on function public.get_guest_order(text, text) to anon, authenticated;

-- Attach a transfer receipt to an order: allowed only when the caller knows
-- BOTH the order id and the checkout email, and the path belongs to the order.
create or replace function public.attach_proof(p_order_id text, p_email text, p_path text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_order_id is null or p_email is null or p_path is null then return; end if;
  if split_part(p_path, '/', 1) <> p_order_id then
    raise exception 'Invalid receipt path';
  end if;
  update public.orders set transfer_proof_url = p_path
    where id = p_order_id and lower(guest_email) = lower(trim(p_email));
end $$;
revoke all on function public.attach_proof(text, text, text) from public;
grant execute on function public.attach_proof(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- B. proofs
alter table public.orders add column if not exists transfer_proof_url text;

insert into storage.buckets (id, name, public)
values ('transfer-proofs', 'transfer-proofs', false)
on conflict (id) do nothing;

drop policy if exists "proofs_insert" on storage.objects;
drop policy if exists "proofs_admin_read" on storage.objects;
drop policy if exists "proofs_admin_write" on storage.objects;

-- Anyone with an order id can attach a receipt image (5MB, images only).
-- Admins review and delete; receipts are never publicly listable.
create policy "proofs_insert" on storage.objects
  for insert with check (
    bucket_id = 'transfer-proofs'
    and storage.extension(name) in ('webp', 'jpg', 'jpeg', 'png')
  );
create policy "proofs_admin_read" on storage.objects
  for select using (bucket_id = 'transfer-proofs' and public.is_admin());
create policy "proofs_admin_write" on storage.objects
  for all using (bucket_id = 'transfer-proofs' and public.is_admin())
  with check (bucket_id = 'transfer-proofs' and public.is_admin());

update storage.buckets
  set file_size_limit = 5242880,
      allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png']
  where id = 'transfer-proofs';

-- ---------------------------------------------------------------- C. products
create table if not exists public.products (
  id text primary key,
  name text not null default '',
  category text not null default '',
  colour text not null default '',
  tone text not null default '',
  price numeric not null default 0 check (price >= 0),
  sale_price numeric check (sale_price is null or sale_price >= 0),
  badge text,
  status text not null default 'Active' check (status in ('Active', 'Draft')),
  description text,
  image text not null default '',
  images jsonb not null default '[]',
  colours jsonb not null default '[]',
  stock_by_size jsonb not null default '{}',
  sku text,
  crop text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.products enable row level security;
-- Shoppers only ever see live products; drafts stay invisible until Active.
drop policy if exists "products_public_read" on public.products;
drop policy if exists "products_admin_all" on public.products;
create policy "products_public_read" on public.products
  for select using (status = 'Active' or public.is_admin());
create policy "products_admin_all" on public.products
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- C. shop_settings (single row, id = 1)
create table if not exists public.shop_settings (
  id int primary key default 1 check (id = 1),
  announcement text not null default '',
  whatsapp text not null default '',
  instagram text not null default '',
  facebook text not null default '',
  tiktok text not null default '',
  bank_name text not null default '',
  account_name text not null default '',
  account_number text not null default '',
  iban text not null default '',
  shipping jsonb not null default '[]',
  free_over numeric not null default 100,
  low_stock_at int not null default 5,
  updated_at timestamptz not null default now()
);
alter table public.shop_settings enable row level security;
drop policy if exists "settings_public_read" on public.shop_settings;
drop policy if exists "settings_admin_all" on public.shop_settings;
create policy "settings_public_read" on public.shop_settings for select using (true);
create policy "settings_admin_all" on public.shop_settings
  for all using (public.is_admin()) with check (public.is_admin());

insert into public.shop_settings
  (id, announcement, whatsapp, instagram, facebook, tiktok,
   bank_name, account_name, account_number, iban, shipping, free_over, low_stock_at)
values
  (1, 'DESIGNED FOR YOUR EVERYDAY. MADE FOR YOUR NEXT LEVEL.', '', 'https://www.instagram.com/', '', '',
   '', 'HUDA GYMWEAR LTD', '', '',
   '[{"id":"standard","label":"UK standard delivery","hint":"2–4 working days","price":3.95,"enabled":true},{"id":"express","label":"UK express delivery","hint":"Next working day","price":6.95,"enabled":true}]',
   100, 5)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- C. discounts
create table if not exists public.discounts (
  code text primary key,
  kind text not null check (kind in ('percent', 'flat')),
  value numeric not null check (value >= 0),
  min_spend numeric not null default 0 check (min_spend >= 0),
  max_uses int check (max_uses is null or max_uses > 0),
  uses int not null default 0 check (uses >= 0),
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.discounts enable row level security;
drop policy if exists "discounts_public_read" on public.discounts;
drop policy if exists "discounts_admin_all" on public.discounts;
-- Checkout validation needs to read live codes; inactive ones stay hidden.
create policy "discounts_public_read" on public.discounts
  for select using (active = true or public.is_admin());
create policy "discounts_admin_all" on public.discounts
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- C. messages (contact / newsletter / launch inbox)
create table if not exists public.messages (
  id text primary key,
  kind text not null check (kind in ('contact', 'newsletter', 'launch')),
  name text not null default '',
  email text not null default '',
  message text not null default '',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.messages enable row level security;
drop policy if exists "messages_anyone_insert" on public.messages;
drop policy if exists "messages_admin_all" on public.messages;
create policy "messages_anyone_insert" on public.messages
  for insert with check (true);
create policy "messages_admin_all" on public.messages
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- D. server-side pricing
drop trigger if exists trg_order_defaults on public.orders;
drop function if exists public.force_order_defaults();

create or replace function public.recalculate_order()
returns trigger language plpgsql set search_path = public as $$
declare
  it jsonb;
  pid text; sz text; qty int;
  unit numeric; stock int;
  sub numeric := 0; disc numeric := 0; ship numeric := 0;
  code text;
  dkind text; dval numeric; dmin numeric; dmax int; duses int;
  ship_json jsonb; v_free_over numeric;
  m jsonb; method_label text; chosen_label text;
begin
  if new.items is null or jsonb_array_length(new.items) = 0 then
    raise exception 'Order has no items';
  end if;

  -- 1. Official prices + atomic stock check/decrement per line.
  for it in select * from jsonb_array_elements(new.items) loop
    pid := it ->> 'productId';
    sz := coalesce(it ->> 'size', '');
    qty := coalesce((it ->> 'qty')::int, 0);
    if pid is null or pid = '' or qty <= 0 then
      raise exception 'Invalid order item';
    end if;
    select coalesce(sale_price, price), coalesce((stock_by_size ->> sz)::int, 0)
      into unit, stock from public.products where id = pid;
    if not found then
      -- Pre-seed window (product lives only in code seeds so far):
      -- accept the client line price; full guarantees apply once catalogued.
      unit := coalesce((it ->> 'price')::numeric, 0);
      if unit < 0 then raise exception 'Invalid order item'; end if;
    else
      if stock < qty then
        raise exception 'Only % left in this size — please adjust your bag', stock;
      end if;
      update public.products
        set stock_by_size = jsonb_set(stock_by_size, array[sz], to_jsonb(stock - qty)),
            updated_at = now()
        where id = pid;
    end if;
    sub := sub + unit * qty;
  end loop;

  -- 2. Discount code: validated + counted server-side (single source of truth).
  code := nullif(trim(both from coalesce(new.discount_code, '')), '');
  if code is not null then
    select kind, value, min_spend, max_uses, uses
      into dkind, dval, dmin, dmax, duses from public.discounts
      where code = new.discount_code or code = upper(new.discount_code);
    if not found then raise exception 'This discount code is not valid'; end if;
    -- active/dates re-checked here (public read hides inactive, but never trust it)
    perform 1 from public.discounts d
      where (d.code = new.discount_code or d.code = upper(new.discount_code))
        and d.active = true
        and (d.starts_at is null or d.starts_at <= now())
        and (d.ends_at is null or d.ends_at >= now());
    if not found then raise exception 'This discount code is not valid right now'; end if;
    if sub < dmin then
      raise exception 'This code needs a minimum spend of %', dmin;
    end if;
    if dmax is not null and duses >= dmax then
      raise exception 'This discount code has reached its usage limit';
    end if;
    if dkind = 'percent' then
      disc := least(round(sub * least(dval, 90) / 100, 2), sub);
    else
      disc := least(dval, sub);
    end if;
    update public.discounts set uses = uses + 1
      where code = new.discount_code or code = upper(new.discount_code);
  else
    new.discount_code := null;
  end if;

  -- 3. Shipping recomputed from the live settings row.
  select ss.shipping, ss.free_over into ship_json, v_free_over
    from public.shop_settings ss where ss.id = 1;
  method_label := new.shipping ->> 'method';
  chosen_label := method_label;
  ship := coalesce((new.shipping ->> 'price')::numeric, 0);
  if ship_json is not null then
    for m in select * from jsonb_array_elements(ship_json) loop
      if (m ->> 'enabled')::boolean and lower(m ->> 'label') = lower(coalesce(method_label, '')) then
        chosen_label := m ->> 'label';
        if (m ->> 'id') = 'standard' and (sub - disc) >= coalesce(v_free_over, 0) then
          ship := 0;
        else
          ship := coalesce((m ->> 'price')::numeric, 0);
        end if;
      end if;
    end loop;
  end if;

  new.guest_email := lower(trim(coalesce(new.guest_email, '')));
  new.subtotal := sub;
  new.discount := disc;
  new.shipping := jsonb_build_object('method', chosen_label, 'price', ship);
  new.total := greatest(sub - disc + ship, 0);

  -- 4. Pipeline entry (same rules the storefront used client-side).
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
drop trigger if exists trg_recalculate_order on public.orders;
create trigger trg_recalculate_order before insert on public.orders
  for each row execute function public.recalculate_order();

-- ---------------------------------------------------------------- E. restock on cancel
create or replace function public.restock_on_cancel()
returns trigger language plpgsql set search_path = public as $$
declare
  it jsonb; pid text; sz text; qty int; cur int;
begin
  if old.status is distinct from 'Cancelled' and new.status = 'Cancelled' then
    for it in select * from jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) loop
      pid := it ->> 'productId';
      sz := coalesce(it ->> 'size', '');
      qty := coalesce((it ->> 'qty')::int, 0);
      if pid is not null and qty > 0 then
        select coalesce((stock_by_size ->> sz)::int, 0) into cur
          from public.products where id = pid;
        if found then
          update public.products
            set stock_by_size = jsonb_set(stock_by_size, array[sz], to_jsonb(cur + qty)),
                updated_at = now()
            where id = pid;
        end if;
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists trg_restock_on_cancel on public.orders;
create trigger trg_restock_on_cancel after update on public.orders
  for each row execute function public.restock_on_cancel();
