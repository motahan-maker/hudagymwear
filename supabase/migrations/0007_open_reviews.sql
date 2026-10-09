-- HUDA GYMWEAR — open review submission (no sign-in) with admin moderation.
-- Replaces the auth-gated insert policy with an anon+authenticated policy.
-- New reviews always enter moderation as unverified, zero-vote pendings.
-- Admin moderation (reviews_admin_all) and helpful voting (vote_helpful) are unchanged.

drop policy if exists "reviews_owner_insert" on public.reviews;

create policy "reviews_owner_insert" on public.reviews
  for insert to anon, authenticated
  with check (
    status = 'pending' and verified = false and helpful = 0
  );
