import { getSupabase } from './supabase';
import { broadcastStoreEvent } from './realtime';

export type PaymentMethod = 'cod' | 'bank';
export type PaymentStatus = 'Cash on delivery' | 'Pending proof' | 'Paid';
export type OrderStatus =
  | 'Awaiting payment proof'
  | 'Order received'
  | 'Received'
  | 'Packed'
  | 'Shipped'
  | 'Out for delivery'
  | 'Delivered'
  | 'Cancelled';

export const PIPELINE: OrderStatus[] = ['Received', 'Packed', 'Shipped', 'Out for delivery', 'Delivered'];
// Legal moves: forward only, cancel anytime before delivery.
// Bank orders leave 'Awaiting payment proof' exclusively via approvePayment.
export const NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  'Awaiting payment proof': ['Cancelled'],
  'Order received': ['Received', 'Cancelled'],
  Received: ['Packed', 'Cancelled'],
  Packed: ['Shipped', 'Cancelled'],
  Shipped: ['Out for delivery', 'Cancelled'],
  'Out for delivery': ['Delivered', 'Cancelled'],
  Delivered: [],
  Cancelled: [],
};
// Next steps derived from the furthest pipeline point in the order's HISTORY,
// not just its current status — so non-linear histories (e.g. back to
// 'Order received' after 'Received') still offer the correct next step.
export function nextStatuses(o: Order): OrderStatus[] {
  if (o.status === 'Cancelled' || o.status === 'Delivered') return [];
  if (o.payment === 'bank' && o.paymentStatus !== 'Paid') return ['Cancelled'];
  const histMax = Math.max(-1, ...o.timeline.map((t) => statusIndex(t.status)));
  const pos = Math.max(histMax, statusIndex(o.status));
  const out: OrderStatus[] = [];
  // Unknown histories (pos -1) safely restart at Received.
  const nxt = PIPELINE[pos + 1];
  if (nxt) out.push(nxt);
  out.push('Cancelled');
  return out;
}
export const PAYMENT_LABEL: Record<PaymentMethod, string> = { cod: 'Cash on delivery', bank: 'Bank transfer' };

export type OrderItem = {
  productId: string;
  name: string;
  colour: string;
  size: string;
  qty: number;
  price: number;
  image: string;
};
export type OrderAddress = {
  firstName: string; lastName: string; street: string;
  city: string; postcode: string; country: string; phone: string;
};
export type Order = {
  id: string;
  /** Supabase auth user id when placed signed-in (or claimed later). Null = guest. */
  userId?: string;
  email: string;
  customer: string;
  address: OrderAddress;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  discountCode?: string;
  shipping: { method: string; price: number };
  total: number;
  payment: PaymentMethod;
  paymentStatus: PaymentStatus;
  transferRef?: string;
  /** Storage path (or demo-mode data URL) of the uploaded bank transfer receipt. */
  transfer_proof_url?: string;
  // Idempotency key for draft/admin orders: resubmitting the same key
  // returns the existing order instead of creating (and decrementing) twice.
  clientKey?: string;
  status: OrderStatus;
  timeline: { status: OrderStatus; at: string }[];
  createdAt: string;
};

const KEY = 'huda.orders.v1';
function readAll(): Order[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return (JSON.parse(raw) as Order[]).map(normalize);
  } catch { /* ignore */ }
  // Demo seeds exist in dev only — production browsers start with a clean slate.
  if (!import.meta.env.DEV) return [];
  const seeds = seedOrders();
  try { localStorage.setItem(KEY, JSON.stringify(seeds)); } catch { /* ignore */ }
  return seeds;
}
// Backfill fields added after launch so old stored orders never crash renders.
const KNOWN_STATUSES: OrderStatus[] = ['Awaiting payment proof', 'Order received', ...PIPELINE, 'Delivered', 'Cancelled'];
// Orders stored by very first app versions used different status names.
const LEGACY_STATUS: Record<string, OrderStatus> = { Processing: 'Received', Dispatched: 'Shipped' };
function normalize(o: Order): Order {
  const rawStatus = (o as { status: string }).status;
  const status: OrderStatus = LEGACY_STATUS[rawStatus] ?? (KNOWN_STATUSES as string[]).includes(rawStatus) ? (LEGACY_STATUS[rawStatus] ?? (rawStatus as OrderStatus)) : 'Order received';
  return {
    ...o,
    status,
    items: o.items ?? [],
    timeline: o.timeline?.length ? o.timeline : [{ status: o.status, at: o.createdAt }],
    shipping: o.shipping ?? { method: 'UK standard delivery', price: 0 },
    paymentStatus: o.paymentStatus ?? (o.payment === 'bank' ? 'Paid' : 'Cash on delivery'),
  };
}
function writeAll(orders: Order[]) {
  try { localStorage.setItem(KEY, JSON.stringify(orders)); } catch { /* ignore */ }
}
function seedOrders(): Order[] {
  const at = (d: string) => new Date(d).toISOString();
  const mk = (o: Partial<Order> & Pick<Order, 'id' | 'email' | 'customer' | 'total' | 'status'>): Order => ({
    address: { firstName: o.customer.split(' ')[0] ?? 'Guest', lastName: o.customer.split(' ').slice(1).join(' ') || '—', street: '12 Rose Lane', city: 'London', postcode: 'E2 8DP', country: 'United Kingdom', phone: '' },
    items: [], subtotal: o.total, discount: 0, shipping: { method: 'UK standard delivery', price: 0 },
    payment: 'cod', paymentStatus: 'Paid',
    timeline: [{ status: o.status, at: at('2026-10-06T10:00:00') }],
    createdAt: at('2026-10-06T10:00:00'),
    ...o,
  });
  return [
    mk({ id: 'HG-1032', email: 'olivia@example.co.uk', customer: 'Olivia Bennett', total: 80, status: 'Packed' }),
    mk({ id: 'HG-1031', email: 'amelia@example.co.uk', customer: 'Amelia Clarke', total: 113, status: 'Shipped', payment: 'bank' }),
    mk({ id: 'HG-1030', email: 'isla@example.co.uk', customer: 'Isla Morgan', total: 48, status: 'Delivered' }),
    mk({ id: 'HG-1029', email: 'sophie@example.co.uk', customer: 'Sophie Taylor', total: 128, status: 'Delivered', payment: 'bank' }),
  ];
}

type OrderRow = {
  id: string; user_id: string | null; guest_email: string; customer: string;
  address: Order['address']; items: Order['items']; subtotal: number; discount: number;
  discount_code: string | null; shipping: Order['shipping']; total: number;
  payment: string; payment_status: string; transfer_ref: string | null;
  transfer_proof_url: string | null; client_key: string | null; status: string; timeline: Order['timeline']; created_at: string;
};
const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  ...(r.user_id ? { userId: r.user_id } : {}),
  email: r.guest_email, customer: r.customer, address: r.address, items: r.items ?? [],
  subtotal: r.subtotal, discount: r.discount,
  ...(r.discount_code ? { discountCode: r.discount_code } : {}),
  shipping: r.shipping ?? { method: 'UK standard delivery', price: 0 }, total: r.total,
  payment: r.payment as Order['payment'], paymentStatus: r.payment_status as Order['paymentStatus'],
  ...(r.transfer_ref ? { transferRef: r.transfer_ref } : {}),
  ...(r.transfer_proof_url ? { transfer_proof_url: r.transfer_proof_url } : {}),
  ...(r.client_key ? { clientKey: r.client_key } : {}),
  status: r.status as Order['status'], timeline: r.timeline ?? [], createdAt: r.created_at,
});

export async function listOrders(): Promise<Order[]> {
  const sb = getSupabase();
  if (!sb) return readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { data, error } = await sb.from('orders').select('*').order('created_at', { ascending: false });
  if (error) return [];
  return ((data ?? []) as OrderRow[]).map(toOrder);
}
export async function ordersByEmail(email: string): Promise<Order[]> {
  const e = email.trim().toLowerCase();
  const sb = getSupabase();
  if (!sb) return readAll().filter((o) => o.email === e).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { data: { session } } = await sb.auth.getSession();
  let q = sb.from('orders').select('*');
  q = session ? q.or(`user_id.eq.${session.user.id},guest_email.eq.${e}`) : q.eq('guest_email', e);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) return [];
  return ((data ?? []) as OrderRow[]).map(toOrder);
}
export async function ordersByUser(userId: string): Promise<Order[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb.from('orders').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) return [];
  return ((data ?? []) as OrderRow[]).map(toOrder);
}
export async function getOrder(id: string): Promise<Order | undefined> {
  const sb = getSupabase();
  if (!sb) return readAll().find((o) => o.id === id);
  const { data, error } = await sb.from('orders').select('*').eq('id', id).maybeSingle();
  if (error || !data) return undefined;
  return toOrder(data as OrderRow);
}
/** Guest lookup via the `get_guest_order` RPC (id + email verified server-side). */
export async function getGuestOrder(id: string, email: string): Promise<Order | undefined> {
  const cleanId = id.trim().toUpperCase();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanId || !cleanEmail) return undefined;
  const sb = getSupabase();
  if (!sb) return readAll().find((o) => o.id === cleanId && o.email === cleanEmail);
  const { data, error } = await sb.rpc('get_guest_order', { p_order_id: cleanId, p_email: cleanEmail });
  if (error || !data) return undefined;
  const row = data as OrderRow | Order;
  // RPC returns the order as jsonb: map rows via toOrder, plain orders via normalize.
  if (typeof row === 'object' && ('guest_email' in row || 'created_at' in row)) {
    return normalize(toOrder(row as OrderRow));
  }
  if (typeof row === 'object' && 'id' in row) {
    return normalize(row as Order);
  }
  return undefined;
}
/** Attach a transfer receipt path via the `attach_proof` RPC (id + email verified). */
export async function setTransferProof(id: string, email: string, path: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) {
    let ok = false;
    writeAll(readAll().map((o) => {
      if (o.id !== id || o.email !== email.trim().toLowerCase()) return o;
      ok = true;
      return { ...o, transfer_proof_url: path };
    }));
    return ok;
  }
  const { error } = await sb.rpc('attach_proof', { p_order_id: id, p_email: email.trim().toLowerCase(), p_path: path });
  return !error;
}
function nextId(): string {
  const n = readAll().reduce((m, o) => {
    const v = parseInt(o.id.replace('HG-', ''), 10);
    return Number.isFinite(v) ? Math.max(m, v) : m;
  }, 1032);
  return `HG-${n + 1}`;
}
export async function createOrder(input: Omit<Order, 'id' | 'status' | 'timeline' | 'createdAt' | 'paymentStatus'> & { transferRef?: string }): Promise<Order> {
  const initial: OrderStatus = input.payment === 'bank' ? 'Awaiting payment proof' : 'Order received';
  const sb = getSupabase();
  if (!sb) {
    if (input.clientKey) {
      const existing = readAll().find((o) => o.clientKey === input.clientKey);
      if (existing) return existing;
    }
    const order: Order = {
      ...input,
      id: nextId(),
      status: initial,
      paymentStatus: input.payment === 'bank' ? 'Pending proof' : 'Cash on delivery',
      timeline: [{ status: initial, at: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    };
    writeAll([order, ...readAll()]);
    return order;
  }
  if (input.clientKey) {
    const { data: dup } = await sb.from('orders').select('id').eq('client_key', input.clientKey).maybeSingle();
    if (dup) {
      const found = await getOrder((dup as { id: string }).id);
      if (found) return found;
    }
  }
  const id = `HG-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const row = {
    id,
    user_id: input.userId ?? null,
    guest_email: input.email.trim().toLowerCase(),
    customer: input.customer,
    address: input.address,
    items: input.items,
    subtotal: input.subtotal,
    discount: input.discount,
    discount_code: input.discountCode ?? null,
    shipping: input.shipping,
    total: input.total,
    payment: input.payment,
    payment_status: input.payment === 'bank' ? 'Pending proof' : 'Cash on delivery',
    transfer_ref: input.transferRef ?? null,
    client_key: input.clientKey ?? null,
    status: initial,
    timeline: [{ status: initial, at: new Date().toISOString() }],
  };
  const { data, error } = await sb.from('orders').insert(row).select('*').single();
  if (error || !data) throw new Error(error?.message || 'Could not place your order. Please try again.');
  const placed = toOrder(data as OrderRow);
  broadcastStoreEvent('orders:changed', { action: 'create', id: placed.id });
  return placed;
}
async function patchRemote(id: string, fn: (o: Order) => Order): Promise<Order | undefined> {
  const sb = getSupabase()!;
  const current = await getOrder(id);
  if (!current) return undefined;
  const next = fn(current);
  const { error } = await sb.from('orders').update({
    status: next.status,
    payment_status: next.paymentStatus,
    timeline: next.timeline,
  }).eq('id', id);
  if (error) return undefined;
  broadcastStoreEvent('orders:changed', { action: 'update', id });
  return next;
}
function patch(id: string, fn: (o: Order) => Order): Order | undefined {
  let out: Order | undefined;
  writeAll(readAll().map((o) => (o.id === id ? (out = fn(o)) : o)));
  broadcastStoreEvent('orders:changed', { action: 'update', id });
  return out;
}
export async function setOrderStatus(id: string, status: OrderStatus): Promise<Order | undefined> {
  const sb = getSupabase();
  if (!sb) {
    return patch(id, (o) => ({
      ...o,
      status,
      timeline: [...o.timeline, { status, at: new Date().toISOString() }],
    }));
  }
  return patchRemote(id, (o) => ({
    ...o,
    status,
    timeline: [...o.timeline, { status, at: new Date().toISOString() }],
  }));
}
export async function approvePayment(id: string): Promise<Order | undefined> {
  const apply = (o: Order): Order => {
    // Idempotent: approving twice must not duplicate timeline entries.
    if (o.paymentStatus === 'Paid') return o;
    return {
      ...o,
      paymentStatus: 'Paid',
      status: 'Received',
      timeline: [...o.timeline, { status: 'Received' as OrderStatus, at: new Date().toISOString() }],
    };
  };
  const sb = getSupabase();
  if (!sb) return patch(id, apply);
  return patchRemote(id, apply);
}
export async function cancelOrder(id: string): Promise<Order | undefined> {
  return setOrderStatus(id, 'Cancelled');
}
export function statusIndex(status: OrderStatus): number {
  if (status === 'Awaiting payment proof' || status === 'Order received') return -1;
  if (status === 'Cancelled') return -2;
  return PIPELINE.indexOf(status);
}
