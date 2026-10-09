// Customer accounts — real Supabase Auth when configured, local demo otherwise.
//
// - Supabase mode (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY set):
//   email/password + Google OAuth, email verification, real password reset,
//   Postgres profiles/addresses with RLS. Passwords never touch our code.
// - Demo mode (no env): the original localStorage prototype, unchanged.
// All functions are async with identical shapes in both modes.
import { getSupabase, isSupabaseConfigured } from './supabase';
import { ordersByEmail } from './orders';
import { allReviews } from './reviews';

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
export type CustomerNote = { at: string; text: string };
// Local/demo user shape (also what the admin customers table consumes).
export type User = {
  name: string;
  email: string;
  pass: string;
  createdAt: string;
  addresses: Address[];
  notes: CustomerNote[];
  tags: string[];
};
// Authenticated session user (both modes).
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
export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

// ---------------------------------------------------------------------------
// Local demo store (verbatim prototype behaviour, wrapped async)
// ---------------------------------------------------------------------------
const USERS_KEY = 'huda.users.v1';
const SESSION_KEY = 'huda.session.v1';
const WISHLIST_KEY = 'huda.wishlist.v1';

function readUsers(): User[] {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    if (raw) {
      const list = JSON.parse(raw) as User[];
      return list.map((u) => ({ ...u, addresses: u.addresses ?? [], notes: u.notes ?? [], tags: u.tags ?? [] }));
    }
  } catch { /* ignore */ }
  return [];
}
function writeUsers(users: User[]) {
  try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch { /* ignore */ }
}
// Demo-grade obfuscation only — NEVER real security.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `djb2:${h.toString(16)}`;
}
function persistUser(user: User) {
  writeUsers(readUsers().map((u) => (u.email === user.email ? user : u)));
}
function toSession(u: User): SessionUser {
  return {
    id: `local:${u.email}`, email: u.email, name: u.name,
    emailVerified: true, role: 'customer', provider: 'demo', addresses: u.addresses ?? [],
  };
}
function demoSession(): SessionUser | null {
  try {
    const email = localStorage.getItem(SESSION_KEY);
    if (!email) return null;
    const u = readUsers().find((x) => x.email === email);
    return u ? toSession(u) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Supabase row mappers
// ---------------------------------------------------------------------------
type ProfileRow = {
  id: string; email: string; name: string; role: 'customer' | 'admin';
  tags: string[] | null; notes: CustomerNote[] | null; created_at: string;
};
type AddressRow = {
  id: string; user_id: string; label: string; first_name: string; lastName?: never;
  last_name: string; street: string; city: string; postcode: string;
  country: string; phone: string; is_default: boolean;
};
const toAddress = (r: AddressRow): Address => ({
  id: r.id, label: r.label, firstName: r.first_name, lastName: r.last_name,
  street: r.street, city: r.city, postcode: r.postcode, country: r.country,
  phone: r.phone, isDefault: r.is_default,
});
const toInsertAddress = (userId: string, a: Omit<Address, 'id'>) => ({
  user_id: userId, label: a.label, first_name: a.firstName, last_name: a.lastName,
  street: a.street, city: a.city, postcode: a.postcode, country: a.country,
  phone: a.phone, is_default: !!a.isDefault,
});

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
export async function getSessionUser(): Promise<SessionUser | null> {
  const sb = getSupabase();
  if (!sb) return demoSession();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const email = session.user.email ?? '';
  const metaName = (session.user.user_metadata?.['name'] as string) || '';
  let { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (!profile && email) {
    // Self-heal: profile missing (e.g. deleted account signing back in) — recreate it.
    // Insert may conflict when the signup trigger already created the row; re-read then.
    const { error: insErr } = await sb.from('profiles').insert({ id: session.user.id, email, name: metaName });
    if (insErr) {
      const retry = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      profile = (retry.data as ProfileRow | null) ?? profile;
    } else {
      const created = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      profile = (created.data as ProfileRow | null) ?? profile;
    }
  }
  const { data: addrRows } = await sb.from('addresses').select('*').eq('user_id', session.user.id).order('created_at');
  return {
    id: session.user.id,
    email,
    name: (profile as ProfileRow | null)?.name || (session.user.user_metadata?.['name'] as string) || '',
    emailVerified: !!session.user.email_confirmed_at,
    role: ((profile as ProfileRow | null)?.role as SessionUser['role']) || 'customer',
    provider: (session.user.app_metadata?.provider as string) === 'google' ? 'google' : 'email',
    addresses: ((addrRows ?? []) as AddressRow[]).map(toAddress),
  };
}

export function onAuthChange(cb: (u: SessionUser | null) => void): () => void {
  const sb = getSupabase();
  if (!sb) {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SESSION_KEY) void getSessionUser().then(cb);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }
  const { data: { subscription } } = sb.auth.onAuthStateChange(async () => {
    cb(await getSessionUser());
  });
  return () => subscription.unsubscribe();
}

// ---------------------------------------------------------------------------
// Sign up / sign in / sign out
// ---------------------------------------------------------------------------
export async function register(input: { name: string; email: string; password: string }): Promise<AuthResult> {
  const name = input.name.trim();
  const email = norm(input.email);
  if (name.length < 2) return { error: 'Please enter your name.' };
  if (!isEmail(email)) return { error: 'Please enter a valid email address.' };
  if (input.password.length < 6) return { error: 'Password must be at least 6 characters.' };
  const sb = getSupabase();
  if (!sb) {
    const users = readUsers();
    if (users.some((u) => u.email === email)) return { error: 'An account with this email already exists. Try signing in.' };
    const user: User = { name, email, pass: hash(input.password), createdAt: new Date().toISOString(), addresses: [], notes: [], tags: [] };
    users.push(user);
    writeUsers(users);
    try { localStorage.setItem(SESSION_KEY, email); } catch { /* ignore */ }
    return { user: toSession(user) };
  }
  const { data, error } = await sb.auth.signUp({
    email,
    password: input.password,
    options: { data: { name }, emailRedirectTo: `${window.location.origin}/account` },
  });
  if (error) {
    if (/already registered|already exists|duplicate/i.test(error.message)) {
      return { error: 'An account with this email already exists. Try signing in.' };
    }
    return { error: error.message };
  }
  // Supabase returns SUCCESS (no error, no session, no new email) when the
  // address is already registered — the only signal is an empty identities
  // list. Without this check, existing users get a misleading "check inbox".
  if (!data.user || (data.user.identities?.length ?? 0) === 0) {
    return { error: 'An account with this email already exists. Try signing in.' };
  }
  // Email confirmation ON (recommended) => no session yet.
  if (!data.session) return { needsVerification: true };
  await claimGuestOrders();
  await migrateLocalData();
  const fresh = await getSessionUser();
  if (fresh) return { user: fresh };
  return { error: 'Account created — please sign in.' };
}

export async function login(input: { email: string; password: string }): Promise<AuthResult> {
  const email = norm(input.email);
  if (!isEmail(email)) return { error: 'Please enter a valid email address.' };
  if (!input.password) return { error: 'Please enter your password.' };
  const sb = getSupabase();
  if (!sb) {
    const user = readUsers().find((u) => u.email === email);
    if (!user || user.pass !== hash(input.password)) return { error: 'Incorrect email or password.' };
    try { localStorage.setItem(SESSION_KEY, email); } catch { /* ignore */ }
    return { user: toSession(user) };
  }
  const { error } = await sb.auth.signInWithPassword({ email, password: input.password });
  if (error) {
    if (/not confirmed|not verified|confirmation/i.test(error.message)) {
      return { error: 'Please verify your email first — check your inbox for the confirmation link.' };
    }
    return { error: 'Incorrect email or password.' };
  }
  await claimGuestOrders();
  await migrateLocalData();
  const user = await getSessionUser();
  return user ? { user } : { error: 'Signed in, but the profile could not be loaded. Please refresh.' };
}

export async function signInWithGoogle(): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: 'Google sign-in needs Supabase configured.' };
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/account`, queryParams: { access_type: 'offline', prompt: 'consent' } },
  });
  if (error) return { error: error.message };
  return {};
}

export async function logout(): Promise<void> {
  const sb = getSupabase();
  if (sb) {
    try { await sb.auth.signOut(); } catch { /* ignore */ }
    return;
  }
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
export async function resetPassword(email: string): Promise<{ error?: string }> {
  if (!isEmail(email)) return { error: 'Please enter a valid email address.' };
  const sb = getSupabase();
  if (!sb) {
    if (!readUsers().some((u) => u.email === norm(email))) return { error: 'No account found with this email.' };
    // Demo: no email service connected — the storefront cannot send real emails.
    return {};
  }
  const { error } = await sb.auth.resetPasswordForEmail(norm(email), {
    redirectTo: `${window.location.origin}/account/reset`,
  });
  if (error) return { error: error.message };
  return {};
}

/** Sets a new password for the current (recovery or logged-in) session. */
export async function updatePassword(next: string): Promise<{ error?: string }> {
  if (next.length < 6) return { error: 'New password must be at least 6 characters.' };
  const sb = getSupabase();
  if (!sb) return { error: 'Password reset needs Supabase configured.' };
  const { error } = await sb.auth.updateUser({ password: next });
  if (error) return { error: error.message };
  return {};
}

/** Re-sends the signup verification email. Pass the address explicitly when the
 *  user has no session yet (registered but never verified) — otherwise the
 *  current session's email is used. */
export async function resendVerification(email?: string): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return {};
  const addr = email?.trim().toLowerCase()
    ?? (await sb.auth.getSession()).data.session?.user?.email
    ?? '';
  if (!addr) return { error: 'Enter your email address first.' };
  const { error } = await sb.auth.resend({
    type: 'signup',
    email: addr,
    options: { emailRedirectTo: `${window.location.origin}/account` },
  });
  if (error) {
    // "Error sending confirmation email" = the project's SMTP (e.g. Resend)
    // rejected the send — translate to something actionable, keep the rest raw.
    if (/already confirmed|already verified/i.test(error.message)) {
      return { error: 'This email is already verified — please sign in.' };
    }
    if (/rate limit|too many requests|after .* seconds?/i.test(error.message)) {
      return { error: 'Too many attempts — wait a minute and try again.' };
    }
    if (/sending|send.*fail|SMTP|mailer/i.test(error.message)) {
      return { error: 'Email service is unavailable right now. Please try again in a few minutes.' };
    }
    return { error: error.message };
  }
  return {};
}

export async function changePassword(email: string, current: string, next: string): Promise<{ error?: string }> {
  if (next.length < 6) return { error: 'New password must be at least 6 characters.' };
  const sb = getSupabase();
  if (!sb) {
    const users = readUsers();
    const user = users.find((u) => u.email === email);
    if (!user) return { error: 'Account not found.' };
    if (user.pass !== hash(current)) return { error: 'Your current password is incorrect.' };
    writeUsers(users.map((u) => (u.email === email ? { ...u, pass: hash(next) } : u)));
    return {};
  }
  // Supabase has no "verify current password" endpoint: re-authenticate first.
  const { error: signErr } = await sb.auth.signInWithPassword({ email, password: current });
  if (signErr) return { error: 'Your current password is incorrect.' };
  return updatePassword(next);
}

export async function updateProfile(email: string, patch: { name: string }): Promise<{ error?: string }> {
  if (patch.name.trim().length < 2) return { error: 'Please enter your name.' };
  const sb = getSupabase();
  if (!sb) {
    writeUsers(readUsers().map((u) => (u.email === email ? { ...u, name: patch.name.trim() } : u)));
    return {};
  }
  const me = await getSessionUser();
  if (!me) return { error: 'You are signed out. Please sign in again.' };
  const { error } = await sb.from('profiles').update({ name: patch.name.trim() }).eq('id', me.id);
  if (error) return { error: error.message };
  try { await sb.auth.updateUser({ data: { name: patch.name.trim() } }); } catch { /* non-fatal */ }
  return {};
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
export async function saveAddress(email: string, addr: Omit<Address, 'id'> & { id?: string }): Promise<SessionUser | null> {
  const sb = getSupabase();
  if (!sb) {
    const user = readUsers().find((u) => u.email === email);
    if (!user) return null;
    const id = addr.id ?? `addr-${Date.now()}`;
    const next: Address = { ...addr, id };
    let list = user.addresses.some((a) => a.id === id)
      ? user.addresses.map((a) => (a.id === id ? next : a))
      : [...user.addresses, next];
    if (next.isDefault || list.length === 1) list = list.map((a) => ({ ...a, isDefault: a.id === next.id }));
    const updated = { ...user, addresses: list };
    persistUser(updated);
    return toSession(updated);
  }
  const me = await getSessionUser();
  if (!me) return null;
  if (addr.id) {
    const { error } = await sb.from('addresses').update({ ...toInsertAddress(me.id, addr) }).eq('id', addr.id).eq('user_id', me.id);
    if (error) return null;
  } else {
    const { data, error } = await sb.from('addresses').insert(toInsertAddress(me.id, addr)).select('id').single();
    if (error || !data) return null;
    void data;
  }
  // Re-read canonical user, then ensure exactly one default address.
  const fresh = await getSessionUser();
  if (!fresh) return null;
  if (addr.isDefault) {
    const { data: mine } = await sb.from('addresses').select('id').eq('user_id', me.id);
    const allIds = ((mine ?? []) as { id: string }[]).map((r) => r.id);
    // Find the row we just saved: match by unique street+postcode if id unknown.
    let targetId = addr.id ?? '';
    if (!targetId) {
      const { data: match } = await sb.from('addresses').select('id')
        .eq('user_id', me.id).eq('street', addr.street).eq('postcode', addr.postcode)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      targetId = (match as { id: string } | null)?.id ?? '';
    }
    for (const id of allIds) {
      if (id !== targetId) await sb.from('addresses').update({ is_default: false }).eq('id', id);
    }
    if (targetId) await sb.from('addresses').update({ is_default: true }).eq('id', targetId);
    return getSessionUser();
  }
  return fresh;
}

export async function deleteAddress(email: string, id: string): Promise<SessionUser | null> {
  const sb = getSupabase();
  if (!sb) {
    const user = readUsers().find((u) => u.email === email);
    if (!user) return null;
    const list = user.addresses.filter((a) => a.id !== id);
    const updated = { ...user, addresses: list.map((a, i) => ({ ...a, isDefault: a.isDefault ?? i === 0 })) };
    persistUser(updated);
    return toSession(updated);
  }
  const me = await getSessionUser();
  if (!me) return null;
  await sb.from('addresses').delete().eq('id', id).eq('user_id', me.id);
  const fresh = await getSessionUser();
  if (fresh && fresh.addresses.length && !fresh.addresses.some((a) => a.isDefault)) {
    const first = fresh.addresses[0]!;
    await sb.from('addresses').update({ is_default: true }).eq('id', first.id);
    return getSessionUser();
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// GDPR export / erasure
// ---------------------------------------------------------------------------
export async function exportUserData(email: string): Promise<Record<string, unknown> | null> {
  const sb = getSupabase();
  if (!sb) {
    const user = readUsers().find((u) => u.email === email);
    if (!user) return null;
    const { pass: _omit, ...profile } = user;
    void _omit;
    return {
      exportedAt: new Date().toISOString(),
      profile,
      orders: await ordersByEmail(email),
      reviews: (await allReviews()).filter((r) => r.email === email),
    };
  }
  const me = await getSessionUser();
  if (!me) return null;
  const [{ data: profile }, { data: addresses }, { data: orders }, { data: reviews }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', me.id).maybeSingle(),
    sb.from('addresses').select('*').eq('user_id', me.id),
    sb.from('orders').select('*').or(`user_id.eq.${me.id},guest_email.eq.${me.email.toLowerCase()}`),
    sb.from('reviews').select('*').eq('user_id', me.id),
  ]);
  return { exportedAt: new Date().toISOString(), profile, addresses, orders, reviews };
}

export async function deleteAccount(email: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) {
    const users = readUsers();
    if (!users.some((u) => u.email === email)) return false;
    writeUsers(users.filter((u) => u.email !== email));
    try {
      if (localStorage.getItem(SESSION_KEY) === email) localStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
    return true;
  }
  const me = await getSessionUser();
  if (!me) return false;
  // Admins may erase a customer account (GDPR request); users erase only self.
  const targetId = norm(email) === me.email ? me.id : me.role === 'admin' ? await profileIdByEmail(email) : null;
  if (!targetId) return false;
  // Remove addresses; anonymize reviews; delete profile; sign out (self only).
  // NOTE: the auth.users identity itself can only be deleted with the service
  // role (Supabase dashboard → Authentication → Users, or admin API). Until
  // then the login is unusable because no profile exists.
  await sb.from('addresses').delete().eq('user_id', targetId);
  await sb.from('reviews').update({ author: 'Deleted member', email: '' }).eq('user_id', targetId);
  await sb.from('profiles').delete().eq('id', targetId);
  if (targetId === me.id) {
    try { await sb.auth.signOut(); } catch { /* ignore */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Admin (customers)
// ---------------------------------------------------------------------------
export async function listUsers(): Promise<User[]> {
  const sb = getSupabase();
  if (!sb) return readUsers();
  const me = await getSessionUser();
  if (!me || me.role !== 'admin') return [];
  const { data } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
  const { data: addrRows } = await sb.from('addresses').select('*');
  const byUser = new Map<string, Address[]>();
  for (const r of ((addrRows ?? []) as AddressRow[])) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(toAddress(r));
    byUser.set(r.user_id, list);
  }
  return ((data ?? []) as ProfileRow[]).map((p) => ({
    name: p.name, email: p.email, pass: '', createdAt: p.created_at,
    addresses: byUser.get(p.id) ?? [], notes: p.notes ?? [], tags: p.tags ?? [],
  }));
}

export async function addCustomerNote(email: string, text: string): Promise<User | null> {
  if (!text.trim()) return null;
  const sb = getSupabase();
  if (!sb) {
    const user = readUsers().find((u) => u.email === email);
    if (!user) return null;
    const updated = { ...user, notes: [...(user.notes ?? []), { at: new Date().toISOString(), text: text.trim() }] };
    persistUser(updated);
    return updated;
  }
  const users = await listUsers();
  const target = await profileIdByEmail(email);
  if (!target) return users.find((u) => u.email === email) ?? null;
  const existing = ((await supaNotes(target)) as CustomerNote[]);
  await sb.from('profiles').update({ notes: [...existing, { at: new Date().toISOString(), text: text.trim() }] }).eq('id', target);
  return users.find((u) => u.email === email) ?? null;
}

async function supaNotes(profileId: string): Promise<CustomerNote[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data } = await sb.from('profiles').select('notes').eq('id', profileId).maybeSingle();
  return ((data as { notes: CustomerNote[] } | null)?.notes ?? []) as CustomerNote[];
}

async function profileIdByEmail(email: string): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.from('profiles').select('id').eq('email', email.trim().toLowerCase()).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function setCustomerTags(email: string, tags: string[]): Promise<User | null> {
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 12);
  const sb = getSupabase();
  if (!sb) {
    const user = readUsers().find((u) => u.email === email);
    if (!user) return null;
    const updated = { ...user, tags: clean };
    persistUser(updated);
    return updated;
  }
  const target = await profileIdByEmail(email);
  if (!target) return null;
  await sb.from('profiles').update({ tags: clean }).eq('id', target);
  return (await listUsers()).find((u) => u.email === email) ?? null;
}

/** True when the current session belongs to an admin (Supabase role). */
export async function isAdminUser(): Promise<boolean> {
  const me = await getSessionUser();
  return !!me && me.role === 'admin';
}

// ---------------------------------------------------------------------------
// Guest-order claiming + one-time local migration
// ---------------------------------------------------------------------------
let claimedFor: string | null = null;
let claimInFlight: Promise<number> | null = null;

/** Link guest orders (same email) to the signed-in account. Returns newly linked count. */
export async function claimGuestOrders(): Promise<number> {
  // Single-flight: login() and the account-page effect race otherwise.
  if (claimInFlight) return claimInFlight;
  claimInFlight = runClaim();
  try {
    return await claimInFlight;
  } finally {
    claimInFlight = null;
  }
}
async function runClaim(): Promise<number> {
  const sb = getSupabase();
  if (!sb) return 0;
  const me = await getSessionUser();
  if (!me || claimedFor === me.id) return 0;
  const { count: before } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', me.id);
  const { error } = await sb.rpc('claim_guest_orders');
  if (error) return 0;
  claimedFor = me.id;
  const { count: after } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', me.id);
  return Math.max(0, (after ?? 0) - (before ?? 0));
}

const MIGRATED_KEY = 'huda.migrated.v1';
let migrateInFlight: Promise<{ addresses: number; wishlist: number }> | null = null;

/** One-time move of this browser's demo data (addresses + wishlist) into Supabase. */
export async function migrateLocalData(): Promise<{ addresses: number; wishlist: number }> {
  // Single-flight: concurrent runs would insert the same addresses twice.
  if (migrateInFlight) return migrateInFlight;
  migrateInFlight = runMigrate();
  try {
    return await migrateInFlight;
  } finally {
    migrateInFlight = null;
  }
}
async function runMigrate(): Promise<{ addresses: number; wishlist: number }> {
  const out = { addresses: 0, wishlist: 0 };
  const sb = getSupabase();
  if (!sb) return out;
  const me = await getSessionUser();
  if (!me) return out;
  try {
    if (localStorage.getItem(MIGRATED_KEY) === me.id) return out;
  } catch { return out; }
  // Addresses belonging to the matching local demo user.
  const localUser = readUsers().find((u) => u.email === me.email);
  if (localUser) {
    const existing = new Set(me.addresses.map((a) => `${a.street}|${a.postcode}`.toLowerCase()));
    for (const a of localUser.addresses) {
      if (existing.has(`${a.street}|${a.postcode}`.toLowerCase())) continue;
      const { id: _drop, ...rest } = a;
      void _drop;
      await sb.from('addresses').insert(toInsertAddress(me.id, rest));
      out.addresses++;
    }
    // Retire the local demo record so Supabase is the single source of truth.
    writeUsers(readUsers().filter((u) => u.email !== me.email));
  }
  // Wishlist ids.
  try {
    const raw = localStorage.getItem(WISHLIST_KEY);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    if (Array.isArray(ids) && ids.length) {
      const rows = [...new Set(ids)].map((product_id) => ({ user_id: me.id, product_id }));
      const { error } = await sb.from('wishlist').upsert(rows, { onConflict: 'user_id,product_id', ignoreDuplicates: true });
      if (!error) {
        out.wishlist = rows.length;
        localStorage.removeItem(WISHLIST_KEY);
      }
    }
  } catch { /* ignore */ }
  try { localStorage.setItem(MIGRATED_KEY, me.id); } catch { /* ignore */ }
  return out;
}

// ---------------------------------------------------------------------------
// Wishlist sync (local-first, server-backed when signed in)
// ---------------------------------------------------------------------------
export async function loadWishlist(): Promise<string[]> {
  const sb = getSupabase();
  const readLocal = (): string[] => {
    try {
      const raw = localStorage.getItem(WISHLIST_KEY);
      const ids = raw ? (JSON.parse(raw) as string[]) : [];
      return Array.isArray(ids) ? [...new Set(ids)] : [];
    } catch { return []; }
  };
  if (!sb) return readLocal();
  const me = await getSessionUser();
  const local = readLocal();
  if (!me) return local;
  const { data } = await sb.from('wishlist').select('product_id').eq('user_id', me.id);
  const server = ((data ?? []) as { product_id: string }[]).map((r) => r.product_id);
  const union = [...new Set([...server, ...local])];
  try { localStorage.setItem(WISHLIST_KEY, JSON.stringify(union)); } catch { /* ignore */ }
  if (local.length) {
    const missing = local.filter((id) => !server.includes(id));
    if (missing.length) {
      await sb.from('wishlist')
        .upsert(missing.map((product_id) => ({ user_id: me.id, product_id })), { onConflict: 'user_id,product_id', ignoreDuplicates: true });
    }
  }
  return union;
}

export function persistWishlist(ids: string[]): void {
  try { localStorage.setItem(WISHLIST_KEY, JSON.stringify([...new Set(ids)])); } catch { /* ignore */ }
  const sb = getSupabase();
  if (!sb) return;
  void (async () => {
    try {
      const me = await getSessionUser();
      if (!me) return;
      const { data } = await sb.from('wishlist').select('product_id').eq('user_id', me.id);
      const server = new Set(((data ?? []) as { product_id: string }[]).map((r) => r.product_id));
      const wanted = new Set(ids);
      const toAdd = [...wanted].filter((id) => !server.has(id));
      const toDel = [...server].filter((id) => !wanted.has(id));
      if (toAdd.length) {
        await sb.from('wishlist').upsert(toAdd.map((product_id) => ({ user_id: me.id, product_id })), { onConflict: 'user_id,product_id', ignoreDuplicates: true });
      }
      if (toDel.length) {
        await sb.from('wishlist').delete().eq('user_id', me.id).in('product_id', toDel);
      }
    } catch { /* offline-friendly: local copy of truth remains */ }
  })();
}
