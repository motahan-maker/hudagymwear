import { products, totalStock, money } from './catalog';
import { getSettings, subscribeSettings } from './shop-settings';
import { listOrders, type Order } from './orders';
import { listMessages } from './messages';
import { allReviews } from './reviews';
import { subscribeToStoreEvent, type StoreEventDetail } from './realtime';

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
  types: Record<AlertType, boolean>;
};

const PREFS_KEY = 'huda.alerts.prefs.v1';
const FEED_KEY = 'huda.alerts.feed.v1';
const SNOOZE_KEY = 'huda.alerts.snoozeUntil';
const LAST_SEEN_KEY = 'huda.alerts.lastSeen.v1';
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
  volume: 90,
  vibrate: true,
  systemNotifications: true,
  repeat: true,
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

type Note = { f: number; at: number; dur: number; wave?: OscillatorType; g?: number };

/** Melodies are deliberately different per type so staff learn to recognise
 *  "that's an order" vs "that's the stock buzzer" without looking. */
const MELODY: Record<AlertType, Note[]> = {
  // Loud, urgent, rising triad repeated twice — impossible to ignore.
  order: [
    { f: 1046.5, at: 0, dur: 0.16 }, { f: 1318.5, at: 0.17, dur: 0.16 }, { f: 1568.0, at: 0.34, dur: 0.34 },
    { f: 1046.5, at: 0.78, dur: 0.16 }, { f: 1318.5, at: 0.95, dur: 0.16 }, { f: 1568.0, at: 1.12, dur: 0.4 },
  ],
  // Receipt landed: fast double beep.
  proof: [
    { f: 880, at: 0, dur: 0.12 }, { f: 1174.7, at: 0.14, dur: 0.12 },
    { f: 880, at: 0.3, dur: 0.12 }, { f: 1174.7, at: 0.44, dur: 0.3 },
  ],
  // Message: friendly two-note bell.
  message: [{ f: 880, at: 0, dur: 0.2 }, { f: 659.3, at: 0.22, dur: 0.34 }],
  // Review: softer single chime.
  review: [{ f: 784, at: 0, dur: 0.22 }, { f: 587.3, at: 0.24, dur: 0.34 }],
  // Stock: low buzzer (square wave), deliberately unpleasant.
  stock: [
    { f: 392, at: 0, dur: 0.18, wave: 'square', g: 0.5 },
    { f: 349.2, at: 0.22, dur: 0.3, wave: 'square', g: 0.5 },
  ],
};

function playMelody(type: AlertType) {
  const C = Ctor();
  if (!C) return;
  if (!ctx) { try { ctx = new C(); } catch { return; } }
  if (ctx.state === 'suspended') { void ctx.resume(); return; }
  audioReady = true;
  const now = ctx.currentTime + 0.02;
  const peak = Math.pow(Math.max(0, Math.min(100, prefs.volume)) / 100, 1.6) * 0.85;
  if (peak <= 0.001) return;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 8;
  comp.ratio.value = 12;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  comp.connect(ctx.destination);

  for (const n of MELODY[type]) {
    const start = now + n.at;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak * (n.g ?? 1), start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
    g.connect(comp);
    const a = ctx.createOscillator();
    a.type = n.wave ?? 'sine';
    a.frequency.setValueAtTime(n.f, start);
    a.connect(g);
    a.start(start);
    a.stop(start + n.dur + 0.02);
    // Bright partner a fifth up adds presence on phone speakers.
    if (!n.wave || n.wave === 'sine') {
      const b = ctx.createOscillator();
      const bg = ctx.createGain();
      b.type = 'triangle';
      b.frequency.setValueAtTime(n.f * 1.5, start);
      bg.gain.setValueAtTime(0.0001, start);
      bg.gain.exponentialRampToValueAtTime(peak * 0.32, start + 0.014);
      bg.gain.exponentialRampToValueAtTime(0.0001, start + n.dur * 0.8);
      b.connect(bg);
      bg.connect(comp);
      b.start(start);
      b.stop(start + n.dur + 0.02);
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
function showSystemNotification(a: AlertItem) {
  if (!prefs.systemNotifications || notificationState() !== 'granted') return;
  try {
    const options = {
      body: a.body,
      tag: a.id,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { link: a.link ?? '/admin' },
      requireInteraction: a.type === 'order' || a.type === 'proof',
      renotify: true,
      silent: true,
    } as NotificationOptions;
    const n = new Notification(`HUDA · ${a.title}`, options);
    n.onclick = () => {
      window.focus();
      if (a.link) window.dispatchEvent(new CustomEvent('huda:alert-open', { detail: { link: a.link } }));
      n.close();
    };
  } catch { /* ignore */ }
}

// --- repeat ringer -----------------------------------------------------------
const RING_INTERVAL_MS = 6000;
const RING_MAX_MS = 3 * 60_000;
let ringing: AlertItem[] = [];
let ringTimer: ReturnType<typeof setInterval> | null = null;
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
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  notifyRingers();
}
/** Called by the UI ("Silence" / "Go to order") and by the service worker. */
export function silenceAlarms() {
  stopRinging();
  markAlertsRead();
}
function scheduleRinging(a: AlertItem) {
  if (!prefs.repeat) return;
  if (a.type !== 'order' && a.type !== 'proof' && a.type !== 'stock') return;
  ringing = [a, ...ringing.filter((r) => r.id !== a.id)];
  ringStartedAt = ringStartedAt || Date.now();
  if (!ringTimer) {
    ringTimer = setInterval(() => {
      if (isSnoozed() || !prefs.sound) return;
      if (Date.now() - ringStartedAt > RING_MAX_MS) { stopRinging(); return; }
      if (!ringing.length) { stopRinging(); return; }
      playMelody(ringing[0]!.type);
      vibrate(ringing[0]!.type);
      notifyRingers();
    }, RING_INTERVAL_MS);
  }
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
    showSystemNotification(a);
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
let productTimer: ReturnType<typeof setTimeout> | null = null;

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
