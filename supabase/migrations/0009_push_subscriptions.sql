-- 0009_push_subscriptions.sql
-- HUDA GYMWEAR — closed-app admin alerts (Web Push)
--
-- WHY THIS EXISTS:
--   Supabase Realtime only reaches a browser while that page is alive. On a
--   phone, the Brand Studio tab/App is frozen minutes after it is hidden, so a
--   new order placed at 23:00 rings nothing. Web Push is the only channel that
--   is delivered by the OS itself: the browser wakes the service worker
--   (public/sw.js, `push` handler) and shows the notification with the app
--   fully closed.
--
--   The client side (src/lib/alerts.ts → enablePush()) subscribes the installed
--   PWA with a VAPID public key and stores the resulting endpoint + p256dh/auth
--   keys here. The sender is the Edge Function at
--   supabase/functions/order-push, which reads this table with the service role
--   and encrypts a payload per subscription.
--
-- SECURITY:
--   Endpoints and their key material are bearer credentials: anyone holding a
--   row can push notifications to that device. Therefore:
--     * RLS is admin-only (public.is_admin() from 0003) for every operation.
--     * `anon` and `authenticated` customers get nothing — the storefront never
--       touches this table (guest checkout stays push-free by design).
--     * Only the service role (the Edge Function) may read the whole table, and
--       it is never exposed to the client.
--   Nothing here stores order data; the push payload is generated at send time.
--
-- This file is re-runnable. Run it BEFORE following supabase/PUSH_SETUP.md.

-- ---------------------------------------------------------------- the table
create table if not exists public.push_subscriptions (
  endpoint      text primary key,
  keys_p256dh   text not null,
  keys_auth     text not null,
  user_agent    text not null default '',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- A browser drops a subscription when the PWA is uninstalled or the OS
  -- revokes it; the sender gets a 404/410 and marks the row dead instead of
  -- retrying a burnt endpoint on every order.
  expired_at    timestamptz
);

comment on table public.push_subscriptions is
  'VAPID push endpoints for HUDA admin devices. Bearer credentials — admin-only RLS.';

-- ---------------------------------------------------------------- RLS
alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_admin_all" on public.push_subscriptions;
create policy "push_subscriptions_admin_all" on public.push_subscriptions
  for all using (public.is_admin()) with check (public.is_admin());

-- Guests and customers must not read, write, or even probe the table.
revoke all on table public.push_subscriptions from anon;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;
grant all on table public.push_subscriptions to service_role;

-- ---------------------------------------------------------------- housekeeping
-- The sender only ever needs live endpoints; an admin panel listing shows the
-- most recent device first.
create index if not exists push_subscriptions_live_idx
  on public.push_subscriptions (last_seen_at desc)
  where expired_at is null;
