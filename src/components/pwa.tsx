import { useEffect, useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { canInstall, isIos, isStandalone, promptInstall, subscribeInstall, type InstallOutcome } from '@/lib/pwa';

/**
 * Install button for the admin topbar / login screen.
 * Android + desktop Chrome/Edge: one-tap native install prompt.
 * iOS Safari: no install event exists, so we show the 3-step manual guide.
 */
export function InstallButton({ compact }: { compact?: boolean }) {
  const [available, setAvailable] = useState(canInstall());
  const [standalone, setStandalone] = useState(isStandalone());
  const [guide, setGuide] = useState(false);
  const [done, setDone] = useState<InstallOutcome | null>(null);

  useEffect(() => subscribeInstall(() => {
    setAvailable(canInstall());
    setStandalone(isStandalone());
  }), []);

  useEffect(() => {
    if (!guide) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setGuide(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [guide]);

  if (standalone) return null;

  return (
    <>
      <Button
        variant={available || isIos() ? 'quiet' : 'tool'}
        className={`install-button ${compact ? 'compact' : ''}`}
        aria-label="Install Brand Studio on your phone"
        onClick={async () => {
          if (available) {
            const r = await promptInstall();
            setDone(r);
            setTimeout(() => setDone(null), 4000);
          } else {
            setGuide(true);
          }
        }}
      >
        <Download size={15} /> {done === 'accepted' ? 'INSTALLED' : compact ? '' : 'INSTALL APP'}
      </Button>
      {guide && (
        <div className="install-guide" role="dialog" aria-label="How to install this app">
          <button type="button" className="install-guide-close" aria-label="Close" onClick={() => setGuide(false)}><X size={15} /></button>
          <h4><Smartphone size={15} /> Add to home screen</h4>
          {isIos() ? (
            <ol>
              <li>Tap the <strong>Share</strong> button in Safari&apos;s toolbar.</li>
              <li>Choose <strong>“Add to Home Screen”</strong>.</li>
              <li>Open HUDA Brand Studio from your icon — it launches full-screen with alert sound.</li>
            </ol>
          ) : (
            <ol>
              <li>Open the browser menu (<strong>⋮</strong>).</li>
              <li>Tap <strong>“Install app” / “Add to Home screen”</strong>.</li>
              <li>Or reload this page — the INSTALL button appears when the browser offers it.</li>
            </ol>
          )}
          <p className="fine-print">Installed app keeps the admin offline-ready, runs full-screen, and can raise phone notifications for new orders.</p>
        </div>
      )}
    </>
  );
}
