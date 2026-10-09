-- HUDA GYMWEAR — guest checkout fix + RPC surface hardening
-- (run AFTER 0001 + 0002 + 0003 + 0004)
--
-- ROOT CAUSE of "permission denied for function is_admin" on PLACE ORDER:
-- Guest (anon) checkout inserts into orders -> BEFORE INSERT trigger
-- recalculate_order() reads products/discounts -> their RLS policies call
-- public.is_admin() -> anon had no EXECUTE grant (0003 granted only
-- authenticated). Signed-in shoppers worked; guests always failed.
--
-- Granting EXECUTE to anon is SAFE here: for anonymous callers auth.uid()
-- is null, so is_admin() can only ever return false — every policy using it
-- still enforces exactly as designed. RLS itself is untouched.
grant execute on function public.is_admin() to anon;

-- Harden the RPC surface: trigger/internal helpers must not be directly
-- callable via PostgREST. Trigger firing does NOT require EXECUTE privilege,
-- so revoking changes nothing for inserts/updates/deletes — it only closes
-- the direct-call path. Grants on real RPCs (get_guest_order, attach_proof,
-- vote_helpful, claim_guest_orders) are intentionally left as they are.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.block_privilege_escalation() from public, anon, authenticated;
revoke all on function public.recalculate_order() from public, anon, authenticated;
revoke all on function public.restock_on_cancel() from public, anon, authenticated;
drop function if exists public.force_order_defaults();
