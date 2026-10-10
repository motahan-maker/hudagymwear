import { products, totalStock, money } from './catalog';
import { getSettings, subscribeSettings } from './shop-settings';
import { listOrders, type Order } from './orders';
import { listMessages } from './messages';
import { allReviews } from './reviews';
import { subscribeToStoreEvent, type StoreEventDetail } from './realtime';
import { getSupabase, isSupabaseConfigured } from './supabase';

/**
 * Admin alert engine for Brand Studio.
 *
 * Watches realtime store events and diffs them against a per-device snapshot so
 * only genuinely NEW things ring (a fresh order, a receipt upload, a new
 * message, a pending review, stock crossing the low/out threshold), then:
 *   1. pushes the alert into a persisted feed,
 *   2. plays a loud Web Audio chime (a different melody per type),
 *   3. repeats the ring for orders/receipts until staff silence it,
 *   4. vibrates and raises a system Notification (great once installed as PWA).
 *
 * Browsers block audio until the user interacts with the page, so
 * `installAudioUnlock()` grabs the first tap/keypress and opens the AudioContext.
 */

export type AlertType = 'order' | 'proof' | 'message' | 'review' | 'stock';

/** Typed so TanStack Router `navigate({ to })` stays type-safe. */
export type AdminLink = '/admin' | '/admin/orders' | '/admin/messages' | '/admin/reviews' | '/admin/inventory';

export type AlertItem = {
  id: string;
  type: AlertType;
  title: string;
  body: string;
  at: string;
  link?: AdminLink | undefined;
  read: boolean;
};

export type AlertPrefs = {
  sound: boolean;
  volume: number; // 0..100
  vibrate: boolean;
  systemNotifications: boolean;
  repeat: boolean; // keep ringing orders/receipts until silenced
  /** Keep the Brand Studio process alive while it is backgrounded so realtime
   *  events still reach the phone, and hold the Web Push subscription. */
  alertsWhenClosed: boolean;
  types: Record<AlertType, boolean>;
};

const PREFS_KEY = 'huda.alerts.prefs.v1';
const FEED_KEY = 'huda.alerts.feed.v1';
const SNOOZE_KEY = 'huda.alerts.snoozeUntil';
const LAST_SEEN_KEY = 'huda.alerts.lastSeen.v1';
const VOLUME_MIGRATED_KEY = 'huda.alerts.loudDefaults.v1';
const FEED_CAP = 50;

export const ALERT_LABEL: Record<AlertType, string> = {
  order: 'New orders',
  proof: 'Payment receipts',
  message: 'New messages',
  review: 'New reviews',
  stock: 'Stock warnings',
};

const DEFAULT_PREFS: AlertPrefs = {
  sound: true,
  volume: 100,
  vibrate: true,
  systemNotifications: true,
  repeat: true,
  alertsWhenClosed: true,
  types: { order: true, proof: true, message: true, review: true, stock: true },
};

// --- prefs -------------------------------------------------------------------
function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch { /* ignore */ }
  return null;
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

let prefs: AlertPrefs = { ...DEFAULT_PREFS, ...(readJson<Partial<AlertPrefs>>(PREFS_KEY) ?? {}) };
prefs.types = { ...DEFAULT_PREFS.types, ...(prefs.types ?? {}) };

// One-time nudge: older builds shipped with volume 90 under a gain curve that
// threw away most of the headroom, so alerts came out noticeably quiet. Only
// untouched defaults move — a volume the owner set themselves is respected.
function migrateQuietDefault() {
  try {
    if (localStorage.getItem(VOLUME_MIGRATED_KEY) === '1') return;
    if (prefs.volume === 90) prefs.volume = DEFAULT_PREFS.volume;
    localStorage.setItem(VOLUME_MIGRATED_KEY, '1');
  } catch { /* SSR / private mode: the compiled defaults already apply */ }
}
migrateQuietDefault();

const prefListeners = new Set<() => void>();
export function getPrefs(): AlertPrefs {
  return prefs;
}
export function subscribePrefs(cb: () => void): () => void {
  prefListeners.add(cb);
  return () => prefListeners.delete(cb);
}
export function setPrefs(patch: Partial<AlertPrefs>): AlertPrefs {
  prefs = {
    ...prefs,
    ...patch,
    types: { ...prefs.types, ...(patch.types ?? {}) },
  };
  writeJson(PREFS_KEY, prefs);
  // Sound/volume/closed-app toggles all change what the background should do.
  applyBackgroundMode();
  prefListeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  return prefs;
}

// --- feed --------------------------------------------------------------------
let feed: AlertItem[] = readJson<AlertItem[]>(FEED_KEY) ?? [];
const feedListeners = new Set<() => void>();
export function getAlerts(): AlertItem[] {
  return feed;
}
export function subscribeAlerts(cb: () => void): () => void {
  feedListeners.add(cb);
  return () => feedListeners.delete(cb);
}
function notifyFeed() {
  [...feedListeners].forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  publishSnapshot();
}

/** Mirror the unread state into the worker's cache. The page cannot run when
 *  the app is closed, but a scheduled worker wake-up can still say "3 alerts
 *  are still waiting" from this snapshot. */
function publishSnapshot() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const unread = feed.filter((a) => !a.read);
  const top = unread[0];
  const snapshot = {
    unread: unread.length,
    at: top?.at ?? new Date().toISOString(),
    summary: top ? `${top.title} · ${top.body}` : '',
  };
  try {
    void navigator.serviceWorker.getRegistration().then((reg) => {
      reg?.active?.postMessage({ type: 'huda:cache-alerts', snapshot });
    }).catch(() => undefined);
  } catch { /* SSR / insecure context */ }
}
export function markAlertsRead() {
  if (!feed.some((a) => !a.read)) return;
  feed = feed.map((a) => (a.read ? a : { ...a, read: true }));
  writeJson(FEED_KEY, feed);
  notifyFeed();
}
export function clearAlerts() {
  feed = [];
  writeJson(FEED_KEY, feed);
  silenceAlarms();
  notifyFeed();
}
export function unreadAlerts(): number {
  return feed.filter((a) => !a.read).length;
}

// --- snooze ------------------------------------------------------------------
export function snoozeUntil(): number {
  return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) || 0;
}
export function isSnoozed(): boolean {
  return snoozeUntil() > Date.now();
}
export function snoozeMinutes(minutes: number) {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + minutes * 60_000)); } catch { /* ignore */ }
  stopRinging();
  notifyFeed();
}

// --- audio -------------------------------------------------------------------
type AudioCtor = typeof AudioContext;
function Ctor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let ctx: AudioContext | null = null;
let audioReady = false;

export function isAudioReady(): boolean {
  return audioReady;
}

/** Create/resume the AudioContext. MUST be called from inside a user gesture. */
export function unlockAudio(): boolean {
  const C = Ctor();
  if (!C) return false;
  try {
    if (!ctx) ctx = new C();
    if (ctx.state === 'suspended') void ctx.resume();
    // A silent 1-sample buffer is the classic unlock nudge for iOS Safari.
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    audioReady = ctx.state === 'running';
    notifyFeed();
    return audioReady;
  } catch {
    return false;
  }
}

let pendingReplay: AlertType | null = null;

type Note = { f: number; at: number; dur: number; wave?: OscillatorType | undefined; g?: number };

/** `beat(f, at, dur, g?, wave?)` — one note of a melody. */
const beat = (f: number, at: number, dur: number, g = 1, wave?: OscillatorType): Note => ({ f, at, dur, g, wave });

/** Melodies are deliberately different per type so staff learn to recognise
 *  "that's an order" vs "that's the stock buzzer" without looking.
 *
 *  They are also written to be LONG (2–3.5s) and to sit in the frequency band a
 *  phone speaker reproduces best (600 Hz – 2.5 kHz), because the old 0.5s sine
 *  pips were over-spent before the phone was even out of a pocket. Every melody
 *  now has a repeated motif (so a partial listen is still recognisable) and ends
 *  on a sustained note (so it keeps sounding while the ringer moves on). */
const MELODY: Record<AlertType, Note[]> = {
  // New order: urgent rising motif, repeated a step higher, then a double knock
  // and a long top bell. ~3.5s — this is the one that must be impossible to ignore.
  order: [
    beat(784, 0, 0.17), beat(988, 0.18, 0.17), beat(1175, 0.36, 0.34),
    beat(880, 0.78, 0.17), beat(1109, 0.96, 0.17), beat(1319, 1.14, 0.34),
    beat(1568, 1.56, 0.3),
    beat(1047, 1.98, 0.12, 0.9), beat(1568, 2.12, 0.12, 0.9),
    beat(2093, 2.3, 1.1, 1.05), beat(1568, 2.3, 1.1, 0.45),
  ],
  // Payment receipt: two quick knocks then a confident three-note climb. ~2.6s
  proof: [
    beat(1047, 0, 0.13), beat(1047, 0.16, 0.13),
    beat(1319, 0.36, 0.26), beat(1568, 0.66, 0.26), beat(2093, 0.96, 0.6),
    beat(1760, 1.7, 0.14), beat(2093, 1.88, 0.7, 1.05),
  ],
  // Message: warm, friendly double chime — clearly not an order. ~1.9s
  message: [
    beat(880, 0, 0.24), beat(1109, 0.26, 0.24), beat(1319, 0.54, 0.44),
    beat(1109, 1.1, 0.2), beat(880, 1.32, 0.55),
  ],
  // Review: soft descending chime, polite but long enough to notice. ~1.6s
  review: [
    beat(1319, 0, 0.22), beat(1175, 0.24, 0.22), beat(880, 0.5, 0.4),
    beat(1175, 0.98, 0.6, 0.7),
  ],
  // Stock: harsh low double-buzz ×4 — deliberately unpleasant. ~2.4s
  stock: [
    beat(392, 0, 0.16, 0.62, 'square'), beat(330, 0.2, 0.16, 0.62, 'square'),
    beat(392, 0.62, 0.16, 0.62, 'square'), beat(330, 0.82, 0.16, 0.62, 'square'),
    beat(392, 1.24, 0.16, 0.62, 'square'), beat(330, 1.44, 0.16, 0.62, 'square'),
    beat(392, 1.86, 0.16, 0.66, 'square'), beat(330, 2.06, 0.34, 0.68, 'square'),
  ],
};

/** Total length of a melody in seconds — the ringer uses it to space repeats. */
export function melodyLength(type: AlertType): number {
  return MELODY[type].reduce((end, note) => Math.max(end, note.at + note.dur), 0);
}

function playMelody(type: AlertType) {
  const C = Ctor();
  if (!C) return;
  if (!ctx) { try { ctx = new C(); } catch { return; } }
  if (ctx.state === 'suspended') { void ctx.resume(); return; }
  audioReady = true;
  const now = ctx.currentTime + 0.02;
  // Perceived loudness, not peak loudness: 1.0 at full volume with the limiter
  // doing the shaping. The old curve (volume^1.6 × 0.85) threw away most of the
  // headroom, which is why the alert sounded polite rather than urgent.
  const peak = Math.pow(Math.max(0, Math.min(100, prefs.volume)) / 100, 1.05);
  if (peak <= 0.001) return;

  // Limiter last in the chain: hard-knee compression at -6 dBFS keeps the long
  // melodies at phone-maximum without the digital clipping that makes a cheap
  // speaker distort (and get turned off).
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.knee.value = 6;
  comp.ratio.value = 16;
  comp.attack.value = 0.001;
  comp.release.value = 0.1;
  comp.connect(ctx.destination);

  for (const note of MELODY[type]) {
    const start = now + note.at;
    const wave: OscillatorType = note.wave ?? 'triangle';
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak * (note.g ?? 1), start + 0.01);
    g.gain.setValueAtTime(peak * (note.g ?? 1), start + note.dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);
    g.connect(comp);
    const a = ctx.createOscillator();
    a.type = wave;
    a.frequency.setValueAtTime(note.f, start);
    a.connect(g);
    a.start(start);
    a.stop(start + note.dur + 0.02);

    // Presence layer: a fifth above, slightly quieter. Phone speakers are worst
    // below ~800 Hz, so the overtone is what actually cuts through a pocket.
    if (wave !== 'square') {
      const b = ctx.createOscillator();
      const bg = ctx.createGain();
      b.type = 'sine';
      b.frequency.setValueAtTime(note.f * 2, start);
      bg.gain.setValueAtTime(0.0001, start);
      bg.gain.exponentialRampToValueAtTime(peak * 0.34, start + 0.012);
      bg.gain.exponentialRampToValueAtTime(0.0001, start + note.dur * 0.9);
      b.connect(bg);
      bg.connect(comp);
      b.start(start);
      b.stop(start + note.dur + 0.02);
    }
    // Body layer: sub-octave, only on the sustained notes, so tablets/desktops
    // feel the alarm without muddying small speakers.
    if (note.dur >= 0.3 && wave !== 'square') {
      const s = ctx.createOscillator();
      const sg = ctx.createGain();
      s.type = 'sine';
      s.frequency.setValueAtTime(note.f / 2, start);
      sg.gain.setValueAtTime(0.0001, start);
      sg.gain.exponentialRampToValueAtTime(peak * 0.22, start + 0.02);
      sg.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);
      s.connect(sg);
      sg.connect(comp);
      s.start(start);
      s.stop(start + note.dur + 0.02);
    }
  }
}


/** Play a sound on demand (used by the "test sound" button). */
export function previewSound(type: AlertType = 'order') {
  if (!audioReady) unlockAudio();
  playMelody(type);
}

// --- vibration ---------------------------------------------------------------
const VIBE: Record<AlertType, number | number[]> = {
  order: [220, 120, 220, 120, 420],
  proof: [180, 90, 180],
  message: [120, 60, 120],
  review: 90,
  stock: [300, 120, 300],
};
function vibrate(type: AlertType) {
  if (!prefs.vibrate) return;
  try { void navigator.vibrate?.(VIBE[type]); } catch { /* ignore */ }
}

// --- system notifications ----------------------------------------------------
const NOTIFY_ICON = '/icons/icon-192.png';

export function notificationState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}
export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (notificationState() === 'unsupported') return 'unsupported';
  try {
    const r = await Notification.requestPermission();
    if (r === 'granted') setPrefs({ systemNotifications: true });
    return r;
  } catch {
    return 'denied';
  }
}

/** The registration this page controls, if the PWA layer is live.
 *  Never awaits `serviceWorker.ready` — that promise stays pending forever when
 *  no worker was installed, which would silently swallow every notification. */
export async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/** True when the app is running as an installed PWA (own window, no browser UI).
 *  Only in that mode do notifications behave like a real phone alert. */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;
  const mm = window.matchMedia?.('(display-mode: standalone)');
  return Boolean(mm?.matches) || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

type PhoneNotification = NotificationOptions & {
  vibrate?: number[] | undefined;
  renotify?: boolean | undefined;
};

export function notificationBody(a: AlertItem): { title: string; opts: PhoneNotification } {
  return {
    title: `HUDA · ${a.title}`,
    opts: {
      body: a.body,
      tag: a.id,
      icon: NOTIFY_ICON,
      badge: NOTIFY_ICON,
      // Orders and receipts stay on the shade until staff act on them.
      requireInteraction: a.type === 'order' || a.type === 'proof',
      // We make our own noise through Web Audio, so the notification itself is
      // silent here — otherwise an order rings twice at the same time.
      silent: true,
      data: { link: a.link ?? '/admin', type: a.type },
      vibrate: prefs.vibrate ? VIBE[a.type] as number[] : undefined,
    },
  };
}

/** Raise the phone notification. Routed through the service worker wherever one
 *  is available: notifications shown by a registration survive the tab being
 *  hidden or closed, stack per-tag, and support `renotify`, which a page-side
 *  `new Notification()` does not. */
async function showSystemNotification(a: AlertItem) {
  if (!prefs.systemNotifications || notificationState() !== 'granted') return;
  const { title, opts } = notificationBody(a);
  const reg = await getRegistration();
  if (reg) {
    try {
      await reg.showNotification(title, { ...opts, renotify: true } as NotificationOptions);
      return;
    } catch { /* fall through to the page-side constructor */ }
  }
  try {
    const built = new Notification(title, opts);
    built.onclick = () => {
      window.focus();
      if (a.link) window.dispatchEvent(new CustomEvent('huda:alert-open', { detail: { link: a.link } }));
      built.close();
    };
  } catch { /* ignore */ }
}

// --- web push (alerts with the app fully closed) ------------------------------
/** Web Push is the only channel that can wake a phone when the Brand Studio is
 *  not running at all: the sender is a Supabase Edge Function fired by an
 *  INSERT trigger on `orders`. It stays completely inert until
 *  VITE_VAPID_PUBLIC_KEY is set, so the storefront never carries dead code paths
 *  for stores that have not done the one-time setup (supabase/PUSH_SETUP.md). */
const VAPID_PUBLIC_KEY = (import.meta.env['VITE_VAPID_PUBLIC_KEY'] as string | undefined) ?? '';

export function pushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY) && isSupabaseConfigured && typeof navigator !== 'undefined' && 'PushManager' in navigator;
}

function urlBase64ToBytes(base64: string): Uint8Array {
  const padded = base64.replace(/_/g, '/').replace(/-/g, '+').padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type PushState = 'unsupported' | 'not-configured' | 'denied' | 'subscribed' | 'unsubscribed';

export async function pushStatus(): Promise<PushState> {
  if (typeof navigator === 'undefined' || !('PushManager' in navigator) || !('serviceWorker' in navigator)) return 'unsupported';
  if (!pushConfigured()) return 'not-configured';
  if (notificationState() !== 'granted') return 'denied';
  const reg = await getRegistration();
  if (!reg?.pushManager) return 'unsupported';
  try {
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
  } catch {
    return 'unsubscribed';
  }
}

/** Subscribe this device for closed-app alerts. The endpoint is stored in
 *  `push_subscriptions`, which only an admin session may write (RLS), and which
 *  the Edge Function reads with the service role key. */
export async function enablePush(): Promise<PushState> {
  if (!pushConfigured()) return 'not-configured';
  if (notificationState() !== 'granted') {
    const r = await requestNotifications();
    if (r !== 'granted') return 'denied';
  }
  const reg = await getRegistration();
  if (!reg?.pushManager) return 'unsupported';
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(VAPID_PUBLIC_KEY) as BufferSource,
      });
    }
    const json = sub.toJSON();
    const keys = json.keys as { p256dh?: string; auth?: string } | undefined;
    const sb = getSupabase();
    if (!sb) return 'unsubscribed';
    const { error } = await sb.from('push_subscriptions').upsert({
      endpoint: json.endpoint ?? '',
      keys_p256dh: keys?.p256dh ?? '',
      keys_auth: keys?.auth ?? '',
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 180) : '',
    }, { onConflict: 'endpoint' });
    return error ? 'unsubscribed' : 'subscribed';
  } catch {
    return 'unsubscribed';
  }
}

/** Ask Chrome to wake the worker periodically (Android installed apps). It is a
 *  courtesy to the OS scheduler, not a timer: the browser decides when, so this
 *  is a backstop for push, never a replacement for it. */
async function registerPeriodicSync(): Promise<void> {
  const reg = await getRegistration();
  const sync = (reg as unknown as { sync?: { register: (tag: string, opts?: { minInterval: number }) => Promise<boolean> } })?.sync;
  if (!sync || typeof document === 'undefined') return;
  try { await sync.register('huda-order-check', { minInterval: 60 * 60 * 1000 }); } catch { /* unsupported */ }
}

// --- background keep-alive ----------------------------------------------------
/** Android freezes a backgrounded tab/installed app after a few idle minutes,
 *  and a frozen process cannot hear Supabase Realtime — which is exactly the
 *  "no alert while the app isn't open" complaint. A tab that is *playing audio*
 *  is exempt from freezing, so hold an ultra-quiet 15.5 kHz tone: above the
 *  range most adults (and every phone speaker) reproduce, but enough for the
 *  browser to treat the page as audible. */
let keepAliveNode: { osc: OscillatorNode; gain: GainNode } | null = null;

export function keepAliveActive(): boolean {
  return keepAliveNode !== null;
}

function startKeepAlive(): boolean {
  if (keepAliveNode || !audioReady) return false;
  if (!ctx || ctx.state !== 'running') return false;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 15500;
    gain.gain.value = 0.02;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    keepAliveNode = { osc, gain };
    return true;
  } catch {
    keepAliveNode = null;
    return false;
  }
}
function stopKeepAlive() {
  if (!keepAliveNode) return;
  try { keepAliveNode.osc.stop(); } catch { /* already stopped */ }
  keepAliveNode.osc.disconnect();
  keepAliveNode.gain.disconnect();
  keepAliveNode = null;
}

/** Re-evaluate the background policy: the tone is on only while the app is
 *  hidden and the owner asked for closed-app alerts; the push subscription is
 *  asked for once per session, never from a loop. */
export function applyBackgroundMode(): void {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (hidden && prefs.alertsWhenClosed && prefs.sound && audioReady) startKeepAlive();
  else stopKeepAlive();
  void ensureClosedAppChannel();
}

let channelTried = false;
async function ensureClosedAppChannel(): Promise<void> {
  if (channelTried || !prefs.alertsWhenClosed || !pushConfigured() || notificationState() !== 'granted') return;
  channelTried = true;
  await enablePush();
  await registerPeriodicSync();
}


// --- repeat ringer -----------------------------------------------------------
/** Gap between repeats: the melody plus a breath, so a 3.5s order alarm never
 *  turns into a wall of noise (which people switch off) but is still going when
 *  the phone comes out of a pocket. */
function ringGap(type: AlertType): number {
  return Math.min(12_000, Math.max(5_000, melodyLength(type) * 1000 + 2_200));
}
const RING_MAX_MS = 5 * 60_000;
let ringing: AlertItem[] = [];
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let ringStartedAt = 0;

export function ringingAlerts(): AlertItem[] {
  return ringing;
}
const ringListeners = new Set<() => void>();
export function subscribeRingers(cb: () => void): () => void {
  ringListeners.add(cb);
  return () => { ringListeners.delete(cb); };
}
function notifyRingers() {
  [...ringListeners].forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}
function stopRinging() {
  ringing = [];
  ringStartedAt = 0;
  if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
  notifyRingers();
}
/** Called by the UI ("Silence" / "Go to order") and by the service worker. */
export function silenceAlarms() {
  stopRinging();
  markAlertsRead();
}
function ringAgain() {
  ringTimer = null;
  if (!ringing.length || isSnoozed() || !prefs.sound) { stopRinging(); return; }
  if (!ringStartedAt || Date.now() - ringStartedAt > RING_MAX_MS) { stopRinging(); return; }
  const top = ringing[0]!;
  playMelody(top.type);
  vibrate(top.type);
  notifyRingers();
  ringTimer = setTimeout(ringAgain, ringGap(top.type));
}
function scheduleRinging(a: AlertItem) {
  if (!prefs.repeat) return;
  if (a.type !== 'order' && a.type !== 'proof' && a.type !== 'stock') return;
  ringing = [a, ...ringing.filter((r) => r.id !== a.id)];
  ringStartedAt = ringStartedAt || Date.now();
  if (!ringTimer) ringTimer = setTimeout(ringAgain, ringGap(a.type));
  notifyRingers();
}

// --- the one entry point -----------------------------------------------------
export function pushAlert(input: { type: AlertType; title: string; body: string; link?: AdminLink }): AlertItem {
  const a: AlertItem = {
    id: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link,
    at: new Date().toISOString(),
    read: false,
  };
  feed = [a, ...feed].slice(0, FEED_CAP);
  writeJson(FEED_KEY, feed);
  notifyFeed();

  const snoozed = isSnoozed();
  if (prefs.sound && !snoozed && prefs.types[a.type]) {
    if (audioReady) playMelody(a.type);
    // Still locked: remember the last sound so the very next tap plays it.
    else pendingReplay = a.type;
  }
  if (!snoozed) {
    vibrate(a.type);
    void showSystemNotification(a);
    scheduleRinging(a);
  }
  return a;
}

// --- watchers ----------------------------------------------------------------
type OrderSig = { status: string; paymentStatus: string; proof: boolean; total: number; customer: string; createdAt: string; payment: string };
function sig(o: { status: string; paymentStatus: string; transfer_proof_url?: string; total: number; customer: string; createdAt: string; payment: string }): OrderSig {
  return { status: o.status, paymentStatus: o.paymentStatus, proof: Boolean(o.transfer_proof_url), total: o.total, customer: o.customer, createdAt: o.createdAt, payment: o.payment };
}

const knownOrders = new Map<string, OrderSig>();
const knownMessages = new Set<string>();
const knownReviews = new Set<string>();
const stockOf = new Map<string, number>();

let primed = false;
let running = false;
let orderBusy = false;

function threshold(): number {
  const v = getSettings().lowStockAt;
  return Number.isFinite(v) && v > 0 ? v : 5;
}

function snapshotProducts() {
  stockOf.clear();
  for (const p of products) stockOf.set(p.id, totalStock(p));
}

async function checkOrders(detail?: StoreEventDetail) {
  if (orderBusy) return;
  orderBusy = true;
  try {
    const list = await listOrders();
    const local = detail?.source === 'local';
    const fresh: Order[] = [];
    for (const o of list) if (!knownOrders.has(o.id)) fresh.push(o);

    if (!primed) {
      // First load after opening the app: don't replay history, but do tell
      // staff about anything that arrived since this device was last here.
      const lastSeen = Number(localStorage.getItem(LAST_SEEN_KEY) ?? 0) || 0;
      const missed = lastSeen ? fresh.filter((o) => new Date(o.createdAt).getTime() > lastSeen) : [];
      for (const o of list) knownOrders.set(o.id, sig(o));
      if (missed.length === 1) {
        const o = missed[0]!;
        pushAlert({
          type: o.payment === 'bank' && o.paymentStatus === 'Pending proof' ? 'proof' : 'order',
          title: `Order ${o.id} arrived while away`,
          body: `${o.customer} · ${money(o.total)} · ${o.payment === 'cod' ? 'Cash on delivery' : 'Bank transfer'}`,
          link: '/admin/orders',
        });
      } else if (missed.length > 1) {
        pushAlert({
          type: 'order',
          title: `${missed.length} new orders`,
          body: `${missed.map((o) => o.id).slice(0, 3).join(', ')}${missed.length > 3 ? '…' : ''} · ${money(missed.reduce((n, o) => n + o.total, 0))}`,
          link: '/admin/orders',
        });
      }
      try { localStorage.setItem(LAST_SEEN_KEY, String(Date.now())); } catch { /* ignore */ }
      primed = true;
      return;
    }

    for (const o of fresh) {
      knownOrders.set(o.id, sig(o));
      if (local) continue; // this device placed it — no need to ring ourselves
      const needsProof = o.payment === 'bank' && o.paymentStatus === 'Pending proof';
      pushAlert({
        type: needsProof ? 'proof' : 'order',
        title: `New order ${o.id}`,
        body: `${o.customer} · ${money(o.total)} · ${o.payment === 'cod' ? 'Cash on delivery' : 'Bank transfer — awaiting proof'}`,
        link: '/admin/orders',
      });
    }

    // Status / receipt changes on known orders.
    for (const o of list) {
      const prev = knownOrders.get(o.id);
      if (!prev) continue;
      const next = sig(o);
      knownOrders.set(o.id, next);
      if (local) continue;
      if (!prev.proof && next.proof) {
        pushAlert({ type: 'proof', title: `Receipt uploaded · ${o.id}`, body: `${o.customer} sent bank transfer proof. Verify then approve.`, link: '/admin/orders' });
      } else if (prev.status !== next.status && !local) {
        const important = next.status === 'Cancelled';
        if (important) pushAlert({ type: 'stock', title: `Order ${o.id} cancelled`, body: `${o.customer} — ${money(o.total)} released back to stock.`, link: '/admin/orders' });
      }
    }
    try { localStorage.setItem(LAST_SEEN_KEY, String(Date.now())); } catch { /* ignore */ }
  } finally {
    orderBusy = false;
  }
}

function checkMessages(local: boolean) {
  const list = listMessages();
  const fresh = list.filter((m) => !knownMessages.has(m.id));
  for (const m of list) knownMessages.add(m.id);
  if (!primed) return;
  if (local) return;
  for (const m of fresh.slice(0, 3)) {
    if (m.read) continue;
    pushAlert({
      type: 'message',
      title: m.kind === 'contact' ? `New message from ${m.name || m.email}` : `New ${m.kind === 'newsletter' ? 'newsletter' : 'launch list'} signup`,
      body: m.message ? m.message.slice(0, 90) : m.email,
      link: '/admin/messages',
    });
  }
  if (fresh.length > 3) pushAlert({ type: 'message', title: `${fresh.length} new inbox entries`, body: 'Open Messages to read them all.', link: '/admin/messages' });
}

async function checkReviews(local: boolean) {
  const list = await allReviews();
  const pending = list.filter((r) => r.status === 'pending');
  const fresh = pending.filter((r) => !knownReviews.has(r.id));
  for (const r of pending) knownReviews.add(r.id);
  if (!primed || local) return;
  for (const r of fresh.slice(0, 2)) {
    pushAlert({ type: 'review', title: `Review awaiting moderation (${r.rating}★)`, body: `${r.author} · ${r.title}`.slice(0, 90), link: '/admin/reviews' });
  }
}

function checkStock() {
  const th = threshold();
  if (!primed) { snapshotProducts(); return; }
  for (const p of products) {
    const now = totalStock(p);
    const prev = stockOf.get(p.id);
    stockOf.set(p.id, now);
    if (prev === undefined) continue;
    if (prev > 0 && now === 0) {
      pushAlert({ type: 'stock', title: `${p.name} is OUT OF STOCK`, body: 'Every size sold out — restock or hide it.', link: '/admin/inventory' });
    } else if (prev > th && now <= th && now > 0) {
      pushAlert({ type: 'stock', title: `${p.name} running low`, body: `${now} left (alert at ${th}).`, link: '/admin/inventory' });
    }
  }
}

/** Attach the admin watchers. Call once from Brand Studio (AdminLayout). */
export function startAdminAlerts(): () => void {
  if (running) return () => {};
  running = true;
  installAudioUnlock();

  const onVisibility = () => applyBackgroundMode();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  applyBackgroundMode();

  const offs: (() => void)[] = [];
  void (async () => {
    await checkOrders();
    checkMessages(true);
    await checkReviews(true);
    checkStock();
  })();

  const debounced = <T,>(fn: (d?: T) => void, ms: number) => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return (d?: T) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn(d); }, ms);
    };
  };

  offs.push(subscribeToStoreEvent('orders:changed', (d) => { void checkOrders(d); }));
  offs.push(subscribeToStoreEvent('reviews:changed', (d) => { void checkReviews(d?.source === 'local'); }));
  offs.push(subscribeToStoreEvent('messages:changed', (d) => { checkMessages(d?.source === 'local'); }));
  const stockDebounced = debounced<StoreEventDetail>((d) => { if (d?.source !== 'local' || d?.action !== 'delete') checkStock(); }, 350);
  offs.push(subscribeToStoreEvent('products:changed', (d) => { stockDebounced(d); }));
  offs.push(subscribeSettings(() => { /* threshold may have moved; re-read on next check */ }));

  return () => {
    running = false;
    primed = false;
    offs.forEach((off) => off());
    stopRinging();
    stopKeepAlive();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    removeAudioUnlock();
  };
}

/** A short toast-free hint: is audio still blocked? (UI shows an ENABLE SOUND CTA.) */
let unlockHandlers: (() => void)[] = [];
function installAudioUnlock() {
  if (typeof window === 'undefined' || unlockHandlers.length) return;
  const fire = () => {
    if (unlockAudio() && pendingReplay) {
      const t = pendingReplay;
      pendingReplay = null;
      playMelody(t);
    }
    if (audioReady) removeAudioUnlock();
  };
  unlockHandlers = [fire, fire, fire];
  window.addEventListener('pointerdown', fire, { passive: true });
  window.addEventListener('keydown', fire);
  window.addEventListener('touchstart', fire, { passive: true });
}
function removeAudioUnlock() {
  if (typeof window === 'undefined') return;
  const [a, b, c] = unlockHandlers;
  if (a) window.removeEventListener('pointerdown', a);
  if (b) window.removeEventListener('keydown', b);
  if (c) window.removeEventListener('touchstart', c);
  unlockHandlers = [];
}
