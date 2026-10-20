-- 0013_printify_permissions.sql
--
-- PURPOSE
--   Stop the browser from writing the Printify tables directly, and give the
--   one write the admin still needs — a reviewed variant mapping — a properly
--   authorised route.
--
-- WHY
--   0010 granted `insert, update, delete` on the printify tables to
--   `authenticated`, and every one of them also has a `for all using
--   (is_admin())` policy. An admin's browser could therefore rewrite the
--   fulfilment state machine, the catalogue mirror and the variant map
--   directly through PostgREST, bypassing the Edge Function that is supposed
--   to own them.
--
--   That is not a privilege escalation — it still needs an admin account —
--   but it does defeat the point of the state machine:
--     - `order_fulfilment.state` is written by claim/release, and a browser
--       could mark an order 'submitted' with no Printify order behind it;
--     - `printify_settings.enabled` is the kill switch for the whole
--       integration, and it could be flipped without the "the connection
--       test succeeded" precondition the Edge Function enforces;
--     - `printify_variant_map` is the trusted (size, colour) -> variant id
--       mapping, and a stray write there produces the wrong garment.
--
--   The safety-critical gates — the admin check, the payment gate, the COD
--   policy — live inside the SECURITY DEFINER functions and are unaffected
--   by this change.
--
-- DATA IMPACT
--   No rows are added, changed or removed. Permissions only.
--
-- PRECONDITIONS
--   0010_printify.sql must have been applied.
--   The admin screens must be using the RPC below rather than writing the
--   tables directly.
--
-- RISKS
--   An admin screen that wrote a printify table directly stops working. The
--   only one that did was the variant map, and it now uses the RPC.
--
-- ROLLBACK
--   Re-grant the privileges:
--     grant insert, update, delete on public.printify_products,
--       public.printify_variant_map, public.order_fulfilment,
--       public.order_fulfilment_lines, public.printify_shipments,
--       public.printify_settings to authenticated;
--   and drop the RPC:
--     drop function if exists public.set_printify_variant_override(text,text,text,integer,boolean);
--
-- Re-runnable: every statement is guarded.

-- ---------------------------------------------------------------------------
-- 1. The write the admin still needs: a reviewed variant mapping
-- ---------------------------------------------------------------------------
create or replace function public.set_printify_variant_override(
  p_external_product_id text,
  p_size text,
  p_colour text,
  p_printify_variant_id integer,
  p_available boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_product_id text;
  v_cost integer;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'not authorised');
  end if;
  if coalesce(trim(p_external_product_id), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'a Printify product is required');
  end if;
  if coalesce(trim(p_size), '') = '' or coalesce(trim(p_colour), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'a size and a colour are required');
  end if;

  select pp.product_id into v_product_id
    from public.printify_products pp
    where pp.external_product_id = p_external_product_id;
  if v_product_id is null then
    return jsonb_build_object('ok', false, 'error', 'that Printify product is not in the catalogue');
  end if;

  -- The cost is the provider's, and is only ever shown for information.
  select coalesce(vm.cost_cents, 0) into v_cost
    from public.printify_variant_map vm
    where vm.external_product_id = p_external_product_id
      and vm.size = btrim(p_size) and vm.colour = btrim(p_colour);

  insert into public.printify_variant_map
    (external_product_id, size, colour, printify_variant_id, sku, cost_cents, available, source, updated_at)
  values
    (p_external_product_id, btrim(p_size), btrim(p_colour), p_printify_variant_id, '', v_cost, coalesce(p_available, true), 'manual', now())
  on conflict (external_product_id, size, colour) do update
    set printify_variant_id = excluded.printify_variant_id,
        available = excluded.available,
        source = 'manual',
        updated_at = now();

  return jsonb_build_object('ok', true,
    'external_product_id', p_external_product_id,
    'size', btrim(p_size),
    'colour', btrim(p_colour),
    'printify_variant_id', p_printify_variant_id);
end $$;

comment on function public.set_printify_variant_override(text,text,text,integer,boolean) is
  'Records a variant mapping an admin has reviewed. Marked manual so a catalogue re-sync does not replace it.';

revoke all on function public.set_printify_variant_override(text,text,text,integer,boolean) from public, anon;
grant execute on function public.set_printify_variant_override(text,text,text,integer,boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The browser may read, and may not write
-- ---------------------------------------------------------------------------
-- The admin screens read these tables. Every write goes through the Edge
-- Function or through an explicitly authorised RPC.
revoke insert, update, delete on table
  public.printify_products,
  public.printify_variant_map,
  public.order_fulfilment,
  public.order_fulfilment_lines,
  public.printify_shipments,
  public.printify_settings
  from anon, authenticated;

-- The catalogue mirror is written by the Edge Function with the service role.
grant all on table
  public.printify_products,
  public.printify_variant_map,
  public.order_fulfilment,
  public.order_fulfilment_lines,
  public.printify_shipments,
  public.printify_settings
  to service_role;

-- The variant map is the one table an admin still writes, and it writes it
-- through the RPC above.
grant insert, update on table public.printify_variant_map to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The claim and release are for a signed-in admin, not for the service role
-- ---------------------------------------------------------------------------
-- Both functions are SECURITY DEFINER and check `public.is_admin()`, which
-- reads `auth.uid()`. A service-role call has no session, so it can only ever
-- be refused. The grant was dead weight that implied the service role could
-- claim an order; it cannot.
revoke all on function public.claim_printify_fulfilment(text) from public, anon, service_role;
revoke all on function public.release_printify_fulfilment(text, uuid, boolean, text, text) from public, anon, service_role;
grant execute on function public.claim_printify_fulfilment(text) to authenticated;
grant execute on function public.release_printify_fulfilment(text, uuid, boolean, text, text) to authenticated;
