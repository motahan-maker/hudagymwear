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

type Listener = () => void;
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

export function notifyStoreEvent(event: StoreEventType): void {
  const set = listeners.get(event);
  if (set) {
    set.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error(`Error in listener for ${event}:`, err);
      }
    });
  }
}

let activeChannel: RealtimeChannel | null = null;
let initialized = false;

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

    // 1. Listen for Supabase Postgres table changes
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'products' },
        () => {
          handlers?.onProductsSync?.();
          notifyStoreEvent('products:changed');
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shop_settings' },
        () => {
          handlers?.onSettingsSync?.();
          handlers?.onCategoriesSync?.();
          notifyStoreEvent('settings:changed');
          notifyStoreEvent('categories:changed');
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'discounts' },
        () => {
          handlers?.onDiscountsSync?.();
          notifyStoreEvent('discounts:changed');
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => {
          handlers?.onOrdersSync?.();
          notifyStoreEvent('orders:changed');
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reviews' },
        () => {
          handlers?.onReviewsSync?.();
          notifyStoreEvent('reviews:changed');
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages' },
        () => {
          handlers?.onMessagesSync?.();
          notifyStoreEvent('messages:changed');
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        () => {
          handlers?.onProfilesSync?.();
          notifyStoreEvent('profiles:changed');
        }
      );

    // 2. Listen for Instant Multi-Device Broadcast Events (<50ms delivery)
    channel.on('broadcast', { event: 'store_broadcast' }, (payload) => {
      const type = payload?.payload?.type as StoreEventType | undefined;
      if (!type) return;

      if (type === 'products:changed') handlers?.onProductsSync?.();
      if (type === 'categories:changed' || type === 'settings:changed') {
        handlers?.onSettingsSync?.();
        handlers?.onCategoriesSync?.();
      }
      if (type === 'discounts:changed') handlers?.onDiscountsSync?.();
      if (type === 'orders:changed') handlers?.onOrdersSync?.();
      if (type === 'reviews:changed') handlers?.onReviewsSync?.();
      if (type === 'messages:changed') handlers?.onMessagesSync?.();
      if (type === 'profiles:changed') handlers?.onProfilesSync?.();

      notifyStoreEvent(type);
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
  // Always notify local listeners first
  notifyStoreEvent(event);

  // Broadcast to other open tabs and devices via Supabase channel
  if (activeChannel && isSupabaseConfigured) {
    try {
      void activeChannel.send({
        type: 'broadcast',
        event: 'store_broadcast',
        payload: { type: event, data, timestamp: Date.now() },
      });
    } catch {
      /* ignore send failure */
    }
  }
}
