import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const anonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined;

/** True when real Supabase credentials are configured. Otherwise the app
 *  runs in local demo mode (localStorage) so `npm run dev` works with zero setup. */
export const isSupabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!client) client = createClient(url!, anonKey!);
  return client;
}
