import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAlerts, getAlerts, getPrefs, isSnoozed, melodyLength, notificationBody,
  pushAlert, pushConfigured, pushStatus, ringingAlerts,
  setPrefs, silenceAlarms, snoozeMinutes, startAdminAlerts, unreadAlerts,
  type AlertItem,
} from './alerts';
import { notifyStoreEvent } from './realtime';
import { products, sizes, type Product } from './catalog';
import type { Order } from './orders';

const ORDERS_KEY = 'huda.orders.v1';
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function order(over: Partial<Order> & Pick<Order, 'id' | 'customer' | 'total' | 'status'>): Order {
  return {
    email: 'shopper@example.co.uk',
    address: { firstName: 'Test', lastName: 'Shopper', street: '12 Rose Lane', city: 'London', postcode: 'E2 8DP', country: 'United Kingdom', phone: '' },
    items: [], subtotal: over.total, discount: 0,
    shipping: { method: 'UK standard delivery', price: 0 },
    payment: 'cod', paymentStatus: 'Cash on delivery',
    timeline: [{ status: over.status, at: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    ...over,
  } as Order;
}
function writeOrders(list: Order[]) {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(list));
}
const titles = () => getAlerts().map((a) => a.title);

afterEach(() => {
  silenceAlarms();
  clearAlerts();
  localStorage.clear();
});

describe('alert feed', () => {
  it('keeps newest first, caps history and counts unread', () => {
    for (let i = 0; i < 60; i++) pushAlert({ type: 'message', title: `Message ${i}`, body: 'inbox' });
    const feed = getAlerts();
    expect(feed.length).toBeLessThanOrEqual(50);
    expect(feed[0]!.title).toBe('Message 59');
    expect(unreadAlerts()).toBe(feed.length);
    silenceAlarms();
    expect(unreadAlerts()).toBe(0);
    clearAlerts();
    expect(getAlerts()).toEqual([]);
  });

  it('persists so alerts raised while the tab was closed survive a reload', () => {
    pushAlert({ type: 'order', title: 'Order HG-1', body: '£40', link: '/admin/orders' });
    const stored = JSON.parse(localStorage.getItem('huda.alerts.feed.v1') ?? '[]') as Array<{ title: string }>;
    expect(stored[0]?.title).toBe('Order HG-1');
  });
});

describe('preferences and snooze', () => {
  it('merges partial patches and persists them', () => {
    setPrefs({ volume: 40, types: { order: false, proof: true, message: true, review: true, stock: true } });
    const p = getPrefs();
    expect(p.volume).toBe(40);
    expect(p.types.order).toBe(false);
    expect(p.types.message).toBe(true); // untouched keys survive
    expect(JSON.parse(localStorage.getItem('huda.alerts.prefs.v1') ?? '{}').volume).toBe(40);
    setPrefs({ volume: 90, types: { order: true, proof: true, message: true, review: true, stock: true } });
  });

  it('snoozes and unsnoozes the ringer', () => {
    expect(isSnoozed()).toBe(false);
    snoozeMinutes(15);
    expect(isSnoozed()).toBe(true);
    snoozeMinutes(0);
    expect(isSnoozed()).toBe(false);
  });
});

describe('repeat ringer', () => {
  it('rings urgent types only, and stops when silenced', () => {
    setPrefs({ repeat: true });
    pushAlert({ type: 'order', title: 'HG-9', body: 'new order' });
    expect(ringingAlerts().map((a) => a.title)).toContain('HG-9');
    pushAlert({ type: 'message', title: 'not urgent', body: 'inbox' });
    expect(ringingAlerts().map((a) => a.title)).not.toContain('not urgent');
    silenceAlarms();
    expect(ringingAlerts()).toEqual([]);
  });

  it('never rings when repeat is off', () => {
    setPrefs({ repeat: false });
    pushAlert({ type: 'order', title: 'HG-quiet', body: 'new order' });
    expect(ringingAlerts()).toEqual([]);
    setPrefs({ repeat: true });
  });
});

describe('watchers', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    clearAlerts();
  });
  afterEach(() => {
    stop?.();
    stop = null;
    clearAlerts();
  });

  it('rings for an order from another device and stays quiet for this device', async () => {
    const first = order({ id: 'HG-100', customer: 'A', total: 40, status: 'Order received' });
    writeOrders([first]);
    stop = startAdminAlerts();
    await settle(150);
    expect(getAlerts()).toEqual([]); // priming never replays history

    const mine = order({ id: 'HG-101', customer: 'B', total: 62, status: 'Order received' });
    writeOrders([first, mine]);
    notifyStoreEvent('orders:changed', { source: 'local', action: 'create', id: 'HG-101' });
    await settle(100);
    expect(titles().join(' | ')).not.toContain('HG-101');

    const theirs = order({ id: 'HG-102', customer: 'C', total: 18, status: 'Order received' });
    writeOrders([first, mine, theirs]);
    notifyStoreEvent('orders:changed', { source: 'remote', action: 'create', id: 'HG-102' });
    await settle(100);
    expect(titles().join(' | ')).toContain('HG-102');
    expect(titles().join(' | ')).not.toContain('HG-101');
  });

  it('raises a receipt alert when an existing order uploads proof', async () => {
    const bank = order({ id: 'HG-200', customer: 'D', total: 80, status: 'Awaiting payment proof', payment: 'bank', paymentStatus: 'Pending proof' });
    writeOrders([bank]);
    stop = startAdminAlerts();
    await settle(150);
    writeOrders([{ ...bank, transfer_proof_url: 'https://example.co.uk/receipt.png' }]);
    notifyStoreEvent('orders:changed', { source: 'remote', action: 'update', id: 'HG-200' });
    await settle(100);
    expect(titles().some((t) => /receipt/i.test(t))).toBe(true);
    expect(getAlerts().some((a) => a.type === 'proof')).toBe(true);
  });

  it('warns when stock empties and again when it crosses the low threshold', async () => {
    const p = products[0] as Product;
    const original = p.stockBySize;
    const withStock = (n: number) => Object.fromEntries(sizes.map((s) => [s, n]));

    p.stockBySize = withStock(50);
    stop = startAdminAlerts();
    await settle(150);

    p.stockBySize = withStock(0);
    notifyStoreEvent('products:changed', { source: 'remote', action: 'update', id: p.id });
    await settle(600); // stock checks are debounced
    expect(titles().some((t) => /OUT OF STOCK/.test(t))).toBe(true);

    clearAlerts();
    p.stockBySize = withStock(50);
    notifyStoreEvent('products:changed', { source: 'remote', action: 'update', id: p.id });
    await settle(600);
    clearAlerts();
    p.stockBySize = withStock(1);
    notifyStoreEvent('products:changed', { source: 'remote', action: 'update', id: p.id });
    await settle(600);
    expect(titles().some((t) => /running low/.test(t))).toBe(true);

    if (original) p.stockBySize = original;
    else delete p.stockBySize;
  });
});

describe('alarm shape', () => {
  it('gives the urgent alerts a long, distinguishable melody', () => {
    // The old pips were ~0.5s and staff missed them in a pocket. Order, receipt
    // and stock alarms must run long enough to be heard and be different lengths
    // from each other so the tune alone identifies the type.
    expect(melodyLength('order')).toBeGreaterThanOrEqual(2.5);
    expect(melodyLength('proof')).toBeGreaterThanOrEqual(2);
    expect(melodyLength('stock')).toBeGreaterThanOrEqual(2);
    const lengths = (['order', 'proof', 'message', 'review', 'stock'] as const).map((t) => melodyLength(t));
    expect(new Set(lengths).size).toBe(5);
  });

  it('keeps the phone notification silent while Web Audio owns the sound', () => {
    const a: AlertItem = { id: 'x1', type: 'order', title: 'New order HG-1', body: '£40', at: new Date().toISOString(), read: false, link: '/admin/orders' };
    const { title, opts } = notificationBody(a);
    expect(title).toBe('HUDA · New order HG-1');
    expect(opts.silent).toBe(true);
    expect(opts.requireInteraction).toBe(true);
    expect(opts.tag).toBe('x1');
    expect((opts.data as { link: string }).link).toBe('/admin/orders');
    expect(notificationBody({ ...a, type: 'review' }).opts.requireInteraction).toBe(false);
  });

  it('stores the closed-app preference and reports push as unavailable without a VAPID key', async () => {
    setPrefs({ alertsWhenClosed: false });
    expect(getPrefs().alertsWhenClosed).toBe(false);
    setPrefs({ alertsWhenClosed: true });
    expect(getPrefs().alertsWhenClosed).toBe(true);
    expect(pushConfigured()).toBe(false); // no VITE_VAPID_PUBLIC_KEY in tests
    // jsdom has no PushManager, so the honest answer is "this device cannot push";
    // either way it must never report an active subscription.
    expect(['unsupported', 'not-configured']).toContain(await pushStatus());
  });
});
