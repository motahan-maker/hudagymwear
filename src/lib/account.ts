// Brand Studio admin auth only — shopper accounts removed.
//
// - Supabase mode (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY set):
//   email/password sign-in with Postgres profiles.role. Only role='admin'
//   grants Brand Studio access (checked via isAdminUser()).
// - Demo mode (no env): auth unavailable; session calls resolve null/error.
// Wishlist is local-only (localStorage 'huda.wishlist.v1', deduped string array).
import { getSupabase, isSupabaseConfigured } from './supabase';

export type Address = {
  id: string;
  label: string;
  firstName: string;
  lastName: string;
  street: string;
  city: string;
  postcode: string;
  country: string;
  phone: string;
  isDefault?: boolean;
};
// Authenticated session user (Supabase-backed; addresses kept as empty list
// for storefront compat — shopper address book deleted).
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: 'customer' | 'admin';
  provider: 'email' | 'google' | 'demo';
  addresses: Address[];
};
export type AuthResult = { user?: SessionUser; error?: string; needsVerification?: boolean };

export const isDemoMode = () => !isSupabaseConfigured;
const norm = (email: string) => email.trim().toLowerCase();
const validEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

const WISHLIST_KEY = 'huda.wishlist.v1';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
export async function getSessionUser(): Promise<SessionUser | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const email = session.user.email ?? '';
  const metaName = (session.user.user_metadata?.['name'] as string) || '';
  const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  const p = profile as { name?: string; role?: SessionUser['role'] } | null;
  return {
    id: session.user.id,
    email,
    name: p?.name || metaName || '',
    emailVerified: !!session.user.email_confirmed_at,
    role: p?.role || 'customer',
    provider: (session.user.app_metadata?.provider as string) === 'google' ? 'google' : 'email',
    addresses: [],
  };
}

export function onAuthChange(cb: (u: SessionUser | null) => void): () => void {
  const sb = getSupabase();
  if (!sb) return () => {};
  const { data: { subscription } } = sb.auth.onAuthStateChange(() => {
    // Avoid calling Supabase while its auth lock is held by this callback.
    window.setTimeout(() => { void getSessionUser().then(cb).catch(() => cb(null)); }, 0);
  });
  return () => subscription.unsubscribe();
}

// ---------------------------------------------------------------------------
// Sign in / sign out (admin)
// ---------------------------------------------------------------------------
export async function login(input: { email: string; password: string }): Promise<AuthResult> {
  const email = norm(input.email);
  if (!validEmail(email)) return { error: 'Please enter a valid email address.' };
  if (!input.password) return { error: 'Please enter your password.' };
  const sb = getSupabase();
  if (!sb) return { error: 'Sign-in is unavailable without Supabase configured.' };
  const { error } = await sb.auth.signInWithPassword({ email, password: input.password });
  if (error) {
    if (/not confirmed|not verified|confirmation/i.test(error.message)) {
      return { error: 'Please verify your email first — check your inbox for the confirmation link.' };
    }
    return { error: 'Incorrect email or password.' };
  }
  const user = await getSessionUser();
  return user ? { user } : { error: 'Signed in, but the profile could not be loaded. Please refresh.' };
}

export async function logout(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try { await sb.auth.signOut(); } catch { /* ignore */ }
}

/** True when the current session belongs to an admin (Supabase role). */
export async function isAdminUser(): Promise<boolean> {
  const me = await getSessionUser();
  return !!me && me.role === 'admin';
}

// ---------------------------------------------------------------------------
// Wishlist (local-only)
// ---------------------------------------------------------------------------
export async function loadWishlist(): Promise<string[]> {
  try {
    const raw = localStorage.getItem(WISHLIST_KEY);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(ids) ? [...new Set(ids)] : [];
  } catch { return []; }
}

export function persistWishlist(ids: string[]): void {
  try { localStorage.setItem(WISHLIST_KEY, JSON.stringify([...new Set(ids)])); } catch { /* ignore */ }
}
