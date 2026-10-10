import { getSupabase, isSupabaseConfigured } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Event types for the store
export type StoreEventType =
  | 'products:changed'
  | 'categories:changed'
  | 'settings:changed'
  | 'discounts:changed'
  | 'orders:changed'
  | 'reviews:changed'
  | 'messages:changed'
  | 'profiles:changed';

/** Extra context carried with every event so listeners can tell *what*
 *  actually happened (a brand new order vs. a status change on an old one),
 *  and whether this device caused it. Used by the admin alert engine. */
export type StoreEventDetail = {
  action?: 'create' | 'update' | 'delete' | 'read' | 'submit' | 'status' | 'reply' | 'upsert' | string | undefined;
  id?: string | undefined;
  /** 'local' = caused by this device/tab, 'remote' = another device's broadcast,
   *  'db' = Supabase postgres_changes replication (could be either). */
  source?: 'local' | 'remote' | 'db' | undefined;
  /** Free-form payload that the originating device attached. */
  data?: Record<string, unknown> | undefined;
};

type Listener = (detail?: StoreEventDetail) => void;
const listeners = new Map<StoreEventType, Set<Listener>>();

export function subscribeToStoreEvent(event: StoreEventType, listener: Listener): () => void {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  const set = listeners.get(event)!;
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

export function notifyStoreEvent(event: StoreEventType, detail?: StoreEventDetail): void {
  const set = listeners.get(event);
  if (set) {
    // Copy first: a listener may unsubscribe while we iterate.
    [...set].forEach((fn) => {
      try {
        fn(detail);
      } catch (err) {
        console.error(`Error in listener for ${event}:`, err);
      }
    });
  }
}

let activeChannel: RealtimeChannel | null = null;
let initialized = false;

/** Best-effort id extraction from a postgres_changes record. */
function recordId(record: unknown): string | undefined {
  if (record && typeof record === 'object' && 'id' in record) {
    const v = (record as { id?: unknown }).id;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Map a Supabase postgres event name onto our action vocabulary. */
function dbAction(eventType: string): string {
  if (eventType === 'INSERT') return 'create';
  if (eventType === 'DELETE') return 'delete';
  return 'update';
}

type TableHandlers = { sync?: () => void | Promise<void>; events: StoreEventType[] };

export function initRealtime(handlers?: {
  onProductsSync?: () => Promise<void> | void;
  onCategoriesSync?: () => Promise<void> | void;
  onSettingsSync?: () => Promise<void> | void;
  onDiscountsSync?: () => Promise<void> | void;
  onOrdersSync?: () => Promise<void> | void;
  onReviewsSync?: () => Promise<void> | void;
  onMessagesSync?: () => Promise<void> | void;
  onProfilesSync?: () => Promise<void> | void;
}): () => void {
  if (initialized || !isSupabaseConfigured) return () => {};
  const sb = getSupabase();
  if (!sb) return () => {};
  initialized = true;

  try {
    const channel = sb.channel('huda-realtime-channel');

    const onTable = (table: string, events: StoreEventType[], sync?: () => void) => {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload: { eventType?: string; record?: unknown }) => {
          sync?.();
          const detail: StoreEventDetail = {
            action: dbAction(payload?.eventType ?? 'UPDATE'),
            id: recordId(payload?.record),
            source: 'db',
          };
          for (const ev of events) notifyStoreEvent(ev, detail);
        }
      );
    };

    // 1. Listen for Supabase Postgres table changes
    onTable('products', ['products:changed'], handlers?.onProductsSync);
    onTable('shop_settings', ['settings:changed', 'categories:changed'], () => {
      void handlers?.onSettingsSync?.();
      void handlers?.onCategoriesSync?.();
    });
    onTable('discounts', ['discounts:changed'], handlers?.onDiscountsSync);
    onTable('orders', ['orders:changed'], handlers?.onOrdersSync);
    onTable('reviews', ['reviews:changed'], handlers?.onReviewsSync);
    onTable('messages', ['messages:changed'], handlers?.onMessagesSync);
    onTable('profiles', ['profiles:changed'], handlers?.onProfilesSync);

    // 2. Listen for Instant Multi-Device Broadcast Events (<50ms delivery)
    channel.on('broadcast', { event: 'store_broadcast' }, (payload: { payload?: { type?: StoreEventType; action?: string; id?: string; data?: Record<string, unknown> } }) => {
      const body = payload?.payload;
      const type = body?.type;
      if (!type) return;

      if (type === 'products:changed') handlers?.onProductsSync?.();
      if (type === 'categories:changed' || type === 'settings:changed') {
        void handlers?.onSettingsSync?.();
        void handlers?.onCategoriesSync?.();
      }
      if (type === 'discounts:changed') handlers?.onDiscountsSync?.();
      if (type === 'orders:changed') handlers?.onOrdersSync?.();
      if (type === 'reviews:changed') handlers?.onReviewsSync?.();
      if (type === 'messages:changed') handlers?.onMessagesSync?.();
      if (type === 'profiles:changed') handlers?.onProfilesSync?.();

      notifyStoreEvent(type, { action: body?.action, id: body?.id, source: 'remote', data: body?.data });
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        // Connected to Realtime
      }
    });

    activeChannel = channel;
  } catch (err) {
    console.error('Failed to initialize Realtime channel:', err);
  }

  return () => {
    if (activeChannel && sb) {
      void sb.removeChannel(activeChannel);
      activeChannel = null;
      initialized = false;
    }
  };
}

export function broadcastStoreEvent(event: StoreEventType, data?: unknown): void {
  const action =
    data && typeof data === 'object' && 'action' in data
      ? String((data as { action?: unknown }).action)
      : undefined;
  const id =
    data && typeof data === 'object' && 'id' in data
      ? String((data as { id?: unknown }).id)
      : undefined;

  // Always notify local listeners first — flagged as locally-caused so the
  // alert engine can stay silent for actions this device just performed.
  notifyStoreEvent(event, {
    action,
    id,
    source: 'local',
    data: data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined,
  });

  // Broadcast to other open tabs and devices via Supabase channel
  if (activeChannel && isSupabaseConfigured) {
    try {
      void activeChannel.send({
        type: 'broadcast',
        event: 'store_broadcast',
        payload: { type: event, action, id, data, timestamp: Date.now() },
      });
    } catch {
      /* ignore send failure */
    }
  }
}

/** True once the realtime channel is up — used by the alert engine to show a
 *  "live / offline" indicator to staff. */
export function isRealtimeLive(): boolean {
  return initialized && activeChannel !== null;
}
