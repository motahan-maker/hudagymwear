-- 0006_realtime_and_categories.sql
-- Enables realtime replication for instant cross-device updates
-- and adds category persistence to shop_settings.

-- 1. Add categories column to shop_settings
alter table if exists public.shop_settings
  add column if not exists categories jsonb default '[
    {"name": "Leggings", "visible": true, "order": 0},
    {"name": "Sports Bras", "visible": true, "order": 1},
    {"name": "Matching Sets", "visible": true, "order": 2},
    {"name": "Hoodies", "visible": true, "order": 3},
    {"name": "Tops & T-Shirts", "visible": true, "order": 4},
    {"name": "Shorts", "visible": true, "order": 5},
    {"name": "Jackets", "visible": true, "order": 6},
    {"name": "Accessories", "visible": true, "order": 7}
  ]'::jsonb;

-- 2. Set replica identity full so realtime updates receive complete row data
alter table if exists public.products replica identity full;
alter table if exists public.shop_settings replica identity full;
alter table if exists public.discounts replica identity full;
alter table if exists public.orders replica identity full;
alter table if exists public.reviews replica identity full;
alter table if exists public.messages replica identity full;
alter table if exists public.profiles replica identity full;

-- 3. Add tables to supabase_realtime publication safely
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.products;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.shop_settings;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.discounts;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.orders;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.reviews;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.messages;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.profiles;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
