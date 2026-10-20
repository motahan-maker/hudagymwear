import { useCallback, useEffect, useMemo, useState } from 'react';
import { listOrders, type Order } from './orders';
import { subscribeToStoreEvent } from './realtime';
import { getProduct, totalStock, useProducts, type Product } from './catalog';
import { useSettings } from './shop-settings';

/**
 * The admin's shared calculations.
 *
 * The overview, the analytics page and the inventory screen all answered the
 * same questions — revenue, order count, average order value, the payment
 * split, which products are running low — and each had its own copy of the
 * arithmetic and its own live subscription. Two copies of a total can drift
 * apart and show the store owner two different numbers, so the arithmetic
 * lives here once.
 */

/**
 * The order list, kept live.
 *
 * One subscription to the realtime channel, shared by every screen that shows
 * orders, rather than one per screen.
 */
export function useOrders(): { orders: Order[]; reload: () => void } {
  const [orders, setOrders] = useState<Order[]>([]);
  const reload = useCallback(() => {
    void listOrders().then(setOrders);
  }, []);
  useEffect(() => {
    reload();
    return subscribeToStoreEvent('orders:changed', reload);
  }, [reload]);
  return { orders, reload };
}

/** The numbers the overview and the analytics page both show. */
export type OrderMetrics = {
  /** Orders that are not cancelled. */
  live: Order[];
  revenue: number;
  averageOrderValue: number;
  orderCount: number;
  codCount: number;
  bankCount: number;
  codShare: number;
};

export function useOrderMetrics(orders: Order[]): OrderMetrics {
  return useMemo(() => {
    const live = orders.filter((o) => o.status !== 'Cancelled');
    const revenue = live.reduce((n, o) => n + o.total, 0);
    const codCount = live.filter((o) => o.payment === 'cod').length;
    const bankCount = live.filter((o) => o.payment === 'bank').length;
    return {
      live,
      revenue,
      averageOrderValue: live.length ? revenue / live.length : 0,
      orderCount: live.length,
      codCount,
      bankCount,
      codShare: live.length ? (codCount / live.length) * 100 : 0,
    };
  }, [orders]);
}

/** Revenue by product, for the best-sellers list. */
export function useBestSellers(live: Order[], limit = 4) {
  return useMemo(() => {
    const sold = new Map<string, { name: string; qty: number; rev: number; image: string }>();
    for (const o of live) {
      for (const it of o.items) {
        const s = sold.get(it.productId) ?? { name: it.name, qty: 0, rev: 0, image: it.image };
        s.qty += it.qty;
        s.rev += it.qty * it.price;
        sold.set(it.productId, s);
      }
    }
    return [...sold.values()].sort((a, b) => b.rev - a.rev).slice(0, limit);
  }, [live, limit]);
}

/** Revenue by category, for the analytics page. */
export function useRevenueByCategory(live: Order[]) {
  return useMemo(() => {
    const byCat = new Map<string, { units: number; rev: number }>();
    for (const o of live) {
      for (const it of o.items) {
        const cat = getProduct(it.productId)?.category ?? '—';
        const s = byCat.get(cat) ?? { units: 0, rev: 0 };
        s.units += it.qty;
        s.rev += it.qty * it.price;
        byCat.set(cat, s);
      }
    }
    return [...byCat.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.rev - a.rev);
  }, [live]);
}

/** Daily revenue for the last `days` days, for the overview chart. */
export function useDailyRevenue(live: Order[], days = 14) {
  return useMemo(() => {
    const labels = [...Array(days)].map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      return d.toISOString().slice(0, 10);
    });
    const values = labels.map((d) => live.filter((o) => o.createdAt.slice(0, 10) === d).reduce((n, o) => n + o.total, 0));
    return { labels, values, max: Math.max(1, ...values) };
  }, [live, days]);
}

/**
 * Products at or below the low-stock threshold.
 *
 * The threshold comes from the store settings, and the same list drives the
 * overview banner, the inventory screen and the stock alerts.
 */
export function useLowStock(): Product[] {
  const products = useProducts();
  const settings = useSettings();
  const threshold = settings.lowStockAt || 5;
  return useMemo(() => products.filter((p) => totalStock(p) <= threshold), [products, threshold]);
}
