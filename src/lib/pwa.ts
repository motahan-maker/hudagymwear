/**
 * PWA plumbing for Brand Studio (and the storefront):
 *  - registers /sw.js in production so the app can be installed and launched
 *    from a phone home screen (Android: manifest + install prompt,
 *    iOS: apple-touch-icon + "Add to Home Screen"),
 *  - exposes the deferred `beforeinstallprompt` so the admin topbar can show a
 *    one-tap INSTALL button instead of relying on Chrome's buried menu.
 */

type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredPrompt: BIPEvent | null = null;
let registered = false;
const listeners = new Set<() => void>();

function ping() {
  [...listeners].forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    // iOS Safari exposes it on navigator instead.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function canInstall(): boolean {
  return deferredPrompt !== null;
}

export function subscribeInstall(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable' | 'unsupported';

export async function promptInstall(): Promise<InstallOutcome> {
  if (!deferredPrompt) return isStandalone() ? 'accepted' : 'unavailable';
  try {
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    ping();
    return outcome;
  } catch {
    return 'unsupported';
  }
}

export async function registerServiceWorker(): Promise<void> {
  if (typeof window === 'undefined' || registered) return;
  if (!('serviceWorker' in navigator)) return;
  // Dev mode: Vite HMR + a caching worker fight each other — skip registration.
  if (!import.meta.env.PROD) return;
  registered = true;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Pick up new versions without waiting for a manual reload.
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          // Tell the UI a refreshed version is ready for staff.
          window.dispatchEvent(new CustomEvent('huda:sw-updated'));
        }
      });
    });
  } catch {
    registered = false;
  }
}

/** Call once from the client root. */
export function initPwa(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BIPEvent;
    ping();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    ping();
  });
  void registerServiceWorker();
}

/** True on iOS Safari where there is no install event — we show manual steps. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
