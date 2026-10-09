// Cookie consent (UK GDPR/PECR): non-blocking choice stored locally.
// Real tracking consent enforcement plugs in here on the backend phase.
export type Consent = { necessary: true; preferences: boolean; decidedAt: string };
const KEY = 'huda.consent.v1';
export function getConsent(): Consent | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Consent;
  } catch { /* ignore */ }
  return null;
}
export function setConsent(preferences: boolean): Consent {
  const next: Consent = { necessary: true, preferences, decidedAt: new Date().toISOString() };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}
