-- 0012_storefront_integrity.sql
--
-- PURPOSE
--   Close the gap in the order-pricing trigger where a line for a product
--   that is not in the catalogue was priced from the value the browser sent.
--
-- WHY
--   `recalculate_order()` is the reason a hostile client cannot forge a
--   total: it re-prices every line from the live `products` row, re-checks
--   the discount, recomputes shipping and decrements stock atomically. It has
--   one exception, added while the catalogue still lived only in code:
--
--       if not found then
--         -- Pre-seed window (product lives only in code seeds so far):
--         -- accept the client line price
--         unit := coalesce((it ->> 'price')::numeric, 0);
--
--   That exception is now a hole. A client can post a line for a product id
--   that does not exist, with its own price, and the order is created at
--   that price — a £0.01 order, for example. The catalogue is populated now,
--   so the exception is no longer needed.
--
--   Two smaller gaps are closed at the same time:
--     - `items[].colour` was never checked against the product's own colour
--       list, so a line could name a colour the product does not come in.
--       The Printify fulfilment claim joins on the exact (size, colour) pair,
--       so a wrong colour here becomes a wrong garment.
--     - a non-numeric `qty` raised a raw cast error, which surfaced an
--       internal message to the shopper.
--
-- DATA IMPACT
--   `recalculate_order_v2` behaves identically to `recalculate_order` for
--   every line whose product is in the catalogue. The ONLY behavioural change
--   is that a line for an unknown product is now refused.
--
-- PRECONDITIONS  (run these first — see the preflight note at the bottom)
--   1. Every product the storefront can sell exists in `public.products`.
--   2. No order in the last 30 days references a product id that is missing
--      from `public.products`.
--   The preflight query is in supabase/VERIFY.sql.
--
-- RISKS
--   If a sellable product is missing from `products`, checkout for that
--   product starts failing with "This item is no longer available". That is
--   the correct refusal — it is the only way to stop a client choosing the
--   price — but it must be checked before the trigger is swapped.
--
-- ROLLBACK
--   `recalculate_order()` is left in place, unchanged. To roll back, re-point
--   the trigger at it:
--     drop trigger if exists trg_recalculate_order on public.orders;
--     create trigger trg_recalculate_order before insert on public.orders
--       for each row execute function public.recalculate_order();
--   No data is changed by the swap, so the rollback is immediate and total.
--
-- Re-runnable: every statement is guarded.

-- ---------------------------------------------------------------------------
-- 1. The trigger function
-- ---------------------------------------------------------------------------
create or replace function public.recalculate_order_v2()
returns trigger language plpgsql set search_path = public as $$
declare
  it jsonb;
  pid text; sz text; qty int; clr text;
  unit numeric; stock int;
  sub numeric := 0; disc numeric := 0; ship numeric := 0;
  code text;
  dkind text; dval numeric; dmin numeric; dmax int; duses int;
  ship_json jsonb; v_free_over numeric;
  m jsonb; method_label text; chosen_label text;
  v_qty_raw text; v_colours jsonb;
begin
  if new.items is null or jsonb_array_length(new.items) = 0 then
    raise exception 'Order has no items';
  end if;

  -- 1. Official prices + atomic stock check/decrement per line.
  for it in select * from jsonb_array_elements(new.items) loop
    pid := it ->> 'productId';
    sz := coalesce(it ->> 'size', '');
    clr := coalesce(it ->> 'colour', '');
    v_qty_raw := it ->> 'qty';
    -- A non-numeric quantity used to raise a raw cast error, which surfaced
    -- an internal message to the shopper.
    if v_qty_raw !~ '^[0-9]+$' then
      raise exception 'Invalid order item';
    end if;
    qty := v_qty_raw::int;
    if pid is null or pid = '' or qty <= 0 then
      raise exception 'Invalid order item';
    end if;

    select coalesce(sale_price, price), coalesce((stock_by_size ->> sz)::int, 0), colours
      into unit, stock, v_colours
      from public.products where id = pid;

    if not found then
      -- The product is not in the catalogue, so there is no trusted price for
      -- it. The browser's price is never a substitute: accepting it is what
      -- let a client order a piece of stock for one penny.
      raise exception 'This item is no longer available - please remove it from your bag';
    end if;

    -- The colour must be one the product actually comes in. Fulfillment
    -- resolves a Printify variant from the exact (size, colour) pair, so a
    -- colour the product does not have can never be produced.
    if v_colours is not null and jsonb_array_length(v_colours) > 0 then
      if not exists (
        select 1 from jsonb_array_elements(v_colours) c
        where lower(coalesce(c ->> 'name', '')) = lower(clr)
      ) then
        raise exception 'This colour is not available for this item - please choose another';
      end if;
    end if;

    if stock < qty then
      raise exception 'Only % left in this size - please adjust your bag', stock;
    end if;
    update public.products
      set stock_by_size = jsonb_set(stock_by_size, array[sz], to_jsonb(stock - qty)),
          updated_at = now()
      where id = pid;

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

comment on function public.recalculate_order_v2() is
  'Server-side order pricing. Refuses a line for a product that is not in the catalogue, so the browser can never choose the price.';

-- Swap the trigger over. The old function is kept for a one-release rollback.
drop trigger if exists trg_recalculate_order on public.orders;
create trigger trg_recalculate_order before insert on public.orders
  for each row execute function public.recalculate_order_v2();

-- ---------------------------------------------------------------------------
-- 2. products.updated_at is maintained by the database
-- ---------------------------------------------------------------------------
-- The admin product editor did not write updated_at, so the column was stale
-- for every catalogue edit and could not be used to tell what changed.
create or replace function public.touch_products_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at before update on public.products
  for each row execute function public.touch_products_updated_at();

-- ---------------------------------------------------------------------------
-- 3. The discount usage counter cannot be rolled back
-- ---------------------------------------------------------------------------
-- The trigger counts a use, and the admin discount editor also sent the
-- counter it had read. Saving a code could therefore undo a redemption.
create or replace function public.guard_discount_uses()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.uses < old.uses then
    raise exception 'The usage count cannot be reduced - it is counted automatically';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_discount_uses on public.discounts;
create trigger trg_guard_discount_uses before update on public.discounts
  for each row execute function public.guard_discount_uses();

-- ---------------------------------------------------------------------------
-- 4. Bounds on what a visitor can write
-- ---------------------------------------------------------------------------
-- The contact form and the review form are open to the public, so their
-- input is bounded. Without a limit a single request can fill the table.
alter table public.messages
  drop constraint if exists messages_name_len_chk;
alter table public.messages
  add constraint messages_name_len_chk check (char_length(name) <= 200);

alter table public.messages
  drop constraint if exists messages_email_len_chk;
alter table public.messages
  add constraint messages_email_len_chk check (char_length(email) <= 320);

alter table public.messages
  drop constraint if exists messages_message_len_chk;
alter table public.messages
  add constraint messages_message_len_chk check (char_length(message) <= 5000);

alter table public.reviews
  drop constraint if exists reviews_title_len_chk;
alter table public.reviews
  add constraint reviews_title_len_chk check (char_length(title) <= 200);

alter table public.reviews
  drop constraint if exists reviews_body_len_chk;
alter table public.reviews
  add constraint reviews_body_len_chk check (char_length(body) <= 5000);

alter table public.reviews
  drop constraint if exists reviews_author_len_chk;
alter table public.reviews
  add constraint reviews_author_len_chk check (char_length(author) <= 200);
