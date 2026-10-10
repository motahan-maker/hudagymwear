import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Bell, BellOff, Volume2, VolumeX, ShoppingBag, Receipt, Mail, Star, Boxes,
  Check, X, Clock, Play, Wifi, WifiOff, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  getAlerts, subscribeAlerts, getPrefs, subscribePrefs, setPrefs, previewSound,
  silenceAlarms, clearAlerts, snoozeMinutes, isSnoozed, ringingAlerts, subscribeRingers,
  requestNotifications, notificationState, isAudioReady, unlockAudio,
  ALERT_LABEL, type AlertType, type AlertItem, type AdminLink,
} from '@/lib/alerts';
import { isRealtimeLive, subscribeToStoreEvent } from '@/lib/realtime';

const ICON: Record<AlertType, typeof Bell> = {
  order: ShoppingBag,
  proof: Receipt,
  message: Mail,
  review: Star,
  stock: Boxes,
};

function useFeed(): AlertItem[] {
  const [list, setList] = useState(getAlerts);
  useEffect(() => subscribeAlerts(() => setList([...getAlerts()])), []);
  return list;
}
function usePrefs() {
  const [p, setP] = useState(getPrefs);
  useEffect(() => subscribePrefs(() => setP(getPrefs())), []);
  return p;
}
function useRinging(): AlertItem[] {
  const [r, setR] = useState(ringingAlerts);
  useEffect(() => subscribeRingers(() => setR([...ringingAlerts()])), []);
  return r;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Floating banner that stays on screen while an order/receipt/stock alarm is
 *  still ringing, so staff can silence it or jump straight to the order. */
export function AlertHud() {
  const ringing = useRinging();
  const navigate = useNavigate();
  const top = ringing[0];
  if (!top) return null;
  const Icon = ICON[top.type];
  return (
    <div className="alert-hud" role="alert" aria-live="assertive">
      <div className="alert-hud-main">
        <span className="alert-hud-icon"><Icon size={18} /></span>
        <div className="alert-hud-text">
          <strong>{top.title}</strong>
          <p>{top.body}</p>
        </div>
        <span className="alert-hud-count">{ringing.length > 1 ? `+${ringing.length - 1}` : null}</span>
      </div>
      <div className="alert-hud-actions">
        <Button variant="fashion" size="sm" onClick={() => { silenceAlarms(); if (top.link) navigate({ to: top.link }); }}>
          <Check size={14} /> OPEN & SILENCE
        </Button>
        <Button variant="quiet" size="sm" onClick={() => silenceAlarms()}>
          <BellOff size={14} /> SILENCE
        </Button>
        <Button variant="tool" aria-label="Snooze alerts for 15 minutes" onClick={() => snoozeMinutes(15)}>
          <Clock size={14} />
        </Button>
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="alert-toggle-row">
      <div className="alert-toggle-label">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`switch ${on ? 'on' : ''}`}
        onClick={() => onChange(!on)}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

/** The dropdown content for the topbar bell: live feed + sound settings. */
export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const feed = useFeed();
  const prefs = usePrefs();
  const navigate = useNavigate();
  const [live, setLive] = useState(isRealtimeLive());
  const [audio, setAudio] = useState(isAudioReady());
  const [snoozed, setSnoozed] = useState(isSnoozed());
  const [permission, setPermission] = useState(notificationState());

  useEffect(() => {
    const tick = () => { setLive(isRealtimeLive()); setAudio(isAudioReady()); setSnoozed(isSnoozed()); };
    const off = subscribeToStoreEvent('settings:changed', tick);
    const t = setInterval(tick, 4000);
    return () => { off(); clearInterval(t); };
  }, []);

  const byType = useMemo(() => {
    const m = new Map<AlertType, number>();
    for (const a of feed.filter((x) => !x.read)) m.set(a.type, (m.get(a.type) ?? 0) + 1);
    return m;
  }, [feed]);

  const go = (link?: AdminLink) => {
    onClose();
    if (link) navigate({ to: link });
  };

  return (
    <div className="notification-panel" role="dialog" aria-label="Notifications and alerts">
      <div className="alert-panel-head">
        <h3><Bell size={14} /> Live alerts</h3>
        <span className={`alert-live ${live ? 'on' : ''}`} title={live ? 'Realtime connected — alerts arrive instantly' : 'Realtime offline: alerts refresh on reload only'}>
          {live ? <Wifi size={12} /> : <WifiOff size={12} />} {live ? 'LIVE' : 'OFFLINE'}
        </span>
        <Button variant="tool" size="sm" aria-label="Close notifications" onClick={onClose}><X size={16} /></Button>
      </div>

      {!audio && (
        <button type="button" className="alert-enable-sound" onClick={() => { unlockAudio(); previewSound('order'); setAudio(isAudioReady()); }}>
          <Volume2 size={16} /> TAP TO ENABLE ALERT SOUND
        </button>
      )}
      {snoozed && (
        <div className="alert-snoozed">
          <Clock size={13} /> Snoozed for a while.
          <Button variant="link" size="sm" onClick={() => { snoozeMinutes(0); setSnoozed(false); }}>unsnooze</Button>
        </div>
      )}

      <div className="alert-feed">
        {feed.length === 0 ? (
          <p className="fine-print">Nothing to ring about. New orders, receipts, messages, reviews and stock warnings land here with sound.</p>
        ) : feed.slice(0, 12).map((a) => {
          const Icon = ICON[a.type];
          return (
            <button key={a.id} type="button" className={`alert-item ${a.read ? 'read' : ''}`} onClick={() => go(a.link)}>
              <span className="alert-item-icon"><Icon size={15} /></span>
              <span className="alert-item-text"><strong>{a.title}</strong><small>{a.body}</small></span>
              <span className="alert-item-time">{ago(a.at)}</span>
            </button>
          );
        })}
      </div>

      <div className="alert-feed-actions">
        <Button variant="quiet" size="sm" onClick={() => silenceAlarms()}><Check size={13} /> MARK READ</Button>
        <Button variant="tool" size="sm" aria-label="Clear alert history" onClick={() => clearAlerts()}><Trash2 size={14} /></Button>
      </div>

      <h4 className="alert-prefs-title">Sound &amp; notifications</h4>
      <div className="alert-prefs">
        <Toggle
          on={prefs.sound}
          label="Alert sound"
          hint={audio ? 'Ready' : 'Silent until you tap once (browser rule)'}
          onChange={(v) => { setPrefs({ sound: v }); if (v) { unlockAudio(); previewSound('order'); } }}
        />
        <div className="alert-volume">
          <span>{prefs.sound ? <Volume2 size={14} /> : <VolumeX size={14} />}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={prefs.volume}
            aria-label="Alert volume"
            onChange={(e) => setPrefs({ volume: Number(e.target.value) })}
            onMouseUp={() => previewSound('message')}
            onTouchEnd={() => previewSound('message')}
          />
          <Button variant="link" size="sm" onClick={() => previewSound('order')}><Play size={12} /> TEST</Button>
        </div>
        <Toggle on={prefs.repeat} label="Keep ringing orders" hint="Repeats every 6s until silenced" onChange={(v) => setPrefs({ repeat: v })} />
        <Toggle on={prefs.vibrate} label="Vibrate" onChange={(v) => setPrefs({ vibrate: v })} />
        <Toggle
          on={prefs.systemNotifications}
          label="Phone notifications"
          hint={permission === 'granted' ? 'Allowed — works when installed as an app' : permission === 'unsupported' ? 'Not supported in this browser' : permission === 'denied' ? 'Blocked in browser settings' : 'Allow once to get lock-screen alerts'}
          onChange={(v) => {
            if (v) void requestNotifications().then((r) => { setPermission(r); setPrefs({ systemNotifications: r === 'granted' }); });
            else setPrefs({ systemNotifications: false });
          }}
        />
        <div className="alert-types">
          {(Object.keys(ALERT_LABEL) as AlertType[]).map((t) => {
            const Icon = ICON[t];
            const on = prefs.types[t];
            const count = byType.get(t) ?? 0;
            return (
              <button
                key={t}
                type="button"
                className={`alert-type ${on ? 'on' : 'off'}`}
                aria-pressed={on}
                onClick={() => setPrefs({ types: { ...prefs.types, [t]: !on } })}
              >
                <Icon size={13} /> {ALERT_LABEL[t]}
                {count > 0 && <span className="alert-type-count">{count}</span>}
                {!on && <X size={11} />}
              </button>
            );
          })}
        </div>
        <div className="alert-snooze">
          <span>Snooze all:</span>
          <Button variant="quiet" size="sm" onClick={() => { snoozeMinutes(15); setSnoozed(true); }}>15 MIN</Button>
          <Button variant="quiet" size="sm" onClick={() => { snoozeMinutes(60); setSnoozed(true); }}>1 HOUR</Button>
          <Button variant="quiet" size="sm" onClick={() => { snoozeMinutes(480); setSnoozed(true); }}>8 HOURS</Button>
        </div>
      </div>
    </div>
  );
}

/** Topbar quick button: mute / unmute sound at a glance. */
export function SoundPill() {
  const prefs = usePrefs();
  const [audio, setAudio] = useState(isAudioReady());
  useEffect(() => {
    const t = setInterval(() => setAudio(isAudioReady()), 3000);
    return () => clearInterval(t);
  }, []);
  const on = prefs.sound && audio;
  return (
    <Button
      variant="tool"
      aria-label={on ? 'Mute alert sound' : 'Enable alert sound'}
      aria-pressed={on}
      className={`sound-pill ${on ? 'on' : ''}`}
      onClick={() => {
        if (!audio) { unlockAudio(); setPrefs({ sound: true }); previewSound('message'); }
        else setPrefs({ sound: !prefs.sound });
        setAudio(isAudioReady());
      }}
    >
      {on ? <Volume2 size={16} /> : <VolumeX size={16} />}
    </Button>
  );
}
