import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { LayoutDashboard, Package, ShoppingBag, Users, BarChart3, Settings, ArrowUpRight, ArrowLeft, Search, Bell, Plus, Pencil, Trash2, Menu, LogOut, Check, Boxes, Tags, BadgePercent, Lock, ImagePlus, X, Copy, Star, Mail, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { products, money, upsertProduct, deleteProduct, totalStock, sizeStock, slugify, tones, badges, sizes, productImage, productColours, getProduct, COLOUR_PRESETS, guessTone, presetFor, effectivePrice, type Product, type ProductColour, type ProductStatus } from '@/lib/catalog';
import { listOrders, getOrder, setOrderStatus, approvePayment, cancelOrder, createOrder, PIPELINE, nextStatuses, PAYMENT_LABEL, type Order, type OrderStatus } from '@/lib/orders';
import { allReviews, setReviewStatus, replyReview, deleteReview, type Review, type ReviewStatus } from '@/lib/reviews';
import { Stars } from '@/components/reviews';
import { downloadCSV } from '@/lib/csv';
import { listMessages, markMessageRead, deleteMessage, unreadMessages } from '@/lib/messages';
import { listDiscounts, saveDiscount, deleteDiscount, type Discount } from '@/lib/discounts';
import { listCategories, saveCategories } from '@/lib/merch';
import { uploadProductImage, fileToWebPDataUrl, deleteProductImage, isStorageReady, TRANSFER_BUCKET } from '@/lib/product-images';
import { getSupabase } from '@/lib/supabase';
import { listUsers, deleteAccount, addCustomerNote, setCustomerTags, login, logout, isAdminUser, isDemoMode, onAuthChange, type User } from '@/lib/account';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getSettings, updateSettings, DEFAULT_SHIPPING } from '@/lib/shop-settings';
import { toast } from 'sonner';
// Brand logo served locally from public/ (no external asset hosting).
const logo = { url: '/favicon.png' };

// --- admin auth (demo gate) ---------------------------------------------------
// Demo gate credentials. Override with VITE_ADMIN_EMAIL / VITE_ADMIN_PASS in
// .env (see .env.example). NOTE: a client-side gate never truly protects data —
// real enforcement happens via Supabase Auth + RLS on the backend phase.
// Demo gate credentials (dev builds only). The PROD bundle never contains a
// fallback password: import.meta.env.DEV is statically replaced at build time,
// so the literal below is dead-code-eliminated from production output.
// Real admin enforcement is Supabase profiles.role='admin' + RLS.
const ADMIN_EMAIL = (import.meta.env['VITE_ADMIN_EMAIL'] as string | undefined) || (import.meta.env.DEV ? 'admin@huda-gymwear.co.uk' : '');
const ADMIN_PASS = (import.meta.env['VITE_ADMIN_PASS'] as string | undefined) || (import.meta.env.DEV ? 'huda2026' : '');
const ADMIN_KEY = 'huda.admin.v1';
export function isAdmin(): boolean {
  try { return sessionStorage.getItem(ADMIN_KEY) === '1'; } catch { return false; }
}
export function adminLogout() {
  try { sessionStorage.removeItem(ADMIN_KEY); } catch { /* ignore */ }
}
export function AdminGuard({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'denied' | 'ok'>(() => (isSupabaseConfigured ? 'loading' : isAdmin() ? 'ok' : 'denied'));
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let live = true;
    const check = () => { isAdminUser().then((a) => { if (live) setState(a ? 'ok' : 'denied'); }); };
    check();
    const off = onAuthChange(check);
    return () => { live = false; off(); };
  }, []);
  if (state === 'ok') return <>{children}</>;
  if (state === 'loading') return <AdminLayout title="Brand Studio"><p className="fine-print">Checking access…</p></AdminLayout>;
  return <AdminLogin onDone={() => setState('ok')} />;
}
export function AdminLogin({ onDone }: { onDone?: () => void }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [showPass, setShowPass] = useState(false);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    if (isSupabaseConfigured) {
      void login({ email, password }).then(async (r) => {
        if (r.error) { setError(r.error); setBusy(false); return; }
        if (await isAdminUser()) {
          toast.success('Welcome back to Brand Studio.');
          if (onDone) onDone(); else navigate({ to: '/admin' });
        } else {
          await logout();
          setError('This account is not an admin. Ask an admin to set role = admin on your profile.');
          setBusy(false);
        }
      });
      return;
    }
    if (email.trim().toLowerCase() === ADMIN_EMAIL && ADMIN_EMAIL !== '' && password === ADMIN_PASS) {
      try { sessionStorage.setItem(ADMIN_KEY, '1'); } catch { /* ignore */ }
      toast.success('Welcome back to Brand Studio.');
      if (onDone) onDone(); else navigate({ to: '/admin' });
    } else { setError('Incorrect admin email or password.'); setBusy(false); }
  }
  return (
    <div className="admin-login-wrap">
      <div className="admin-login">
        <img src={logo.url} alt="HUDA GYMWEAR" />
        <h1>Brand Studio</h1>
        <p>Sign in to manage your store.</p>
        <form onSubmit={submit}>
          <label className="form-field">
            Work email
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={ADMIN_EMAIL || 'admin@hudagymwear.com'} autoComplete="username" required />
          </label>
          <div className="form-field">
            <label htmlFor="admin-pass">Password</label>
            <div style={{position:'relative',display:'flex',alignItems:'center'}}>
              <input
                id="admin-pass"
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                style={{width:'100%',paddingRight:'40px'}}
              />
              <button
                type="button"
                onClick={()=>setShowPass(!showPass)}
                aria-label={showPass ? "Hide password" : "Show password"}
                tabIndex={-1}
                style={{position:'absolute',right:'10px',background:'none',border:'none',cursor:'pointer',padding:'4px',display:'grid',placeItems:'center',color:'var(--muted-foreground)'}}
              >
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
          <Button variant="fashion" type="submit" disabled={busy} className="w-full mt-2">
            <Lock size={14} /> {busy ? 'SIGNING IN…' : 'SIGN IN'}
          </Button>
        </form>
        {isDemoMode() ? (
          import.meta.env.DEV ? (
            <p className="fine-print">Demo access — email: {ADMIN_EMAIL} · password: {ADMIN_PASS}</p>
          ) : (
            <p className="fine-print">Admin access is not configured on this store.</p>
          )
        ) : (
          <p className="fine-print">Production security: Access granted via Supabase Auth with verified <code>role = 'admin'</code>.</p>
        )}
        <Link to="/" className="text-link">← Back to storefront</Link>
      </div>
    </div>
  );
}

// --- shell --------------------------------------------------------------------
// NaN-safe number parsing for admin numeric fields.
function num(v: string, fallback = 0): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
// "Running low" threshold comes from Settings (default 5 units).
function lowAt(): number {
  const v = getSettings().lowStockAt;
  return Number.isFinite(v) && v > 0 ? v : 5;
}
const nav = [
  { label: 'Overview', to: '/admin', icon: LayoutDashboard },
  { label: 'Orders', to: '/admin/orders', icon: ShoppingBag },
  { label: 'Products', to: '/admin/products', icon: Package },
  { label: 'Inventory', to: '/admin/inventory', icon: Boxes },
  { label: 'Categories', to: '/admin/categories', icon: Tags },
  { label: 'Discounts', to: '/admin/discounts', icon: BadgePercent },
  { label: 'Reviews', to: '/admin/reviews', icon: Star },
  { label: 'Customers', to: '/admin/customers', icon: Users },
  { label: 'Messages', to: '/admin/messages', icon: Mail },
  { label: 'Analytics', to: '/admin/analytics', icon: BarChart3 },
  { label: 'Settings', to: '/admin/settings', icon: Settings },
] as const;
export function AdminLayout({ children, title }: { children: ReactNode; title: string }) {
  const [menu, setMenu] = useState(false); const [notifications, setNotifications] = useState(false);
  useEffect(() => {
    if (!menu && !notifications) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(false); setNotifications(false); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu, notifications]);
  const navigate = useNavigate();
  const low = products.filter(p => totalStock(p) <= lowAt() && totalStock(p) > 0).length;
  const out = products.filter(p => totalStock(p) <= 0).length;
  return <div className="admin-layout"><aside className={`admin-sidebar ${menu ? 'open' : ''}`}><Link to="/" className="admin-brand"><img src={logo.url} alt="HUDA GYMWEAR" /><span>BRAND STUDIO<small>Store management</small></span></Link><span className="admin-nav-label">MANAGE</span><nav>{nav.slice(0, 9).map(n => <Link to={n.to} key={n.label} activeProps={{ className: 'active' }} activeOptions={{ exact: n.to === '/admin' }} onClick={() => setMenu(false)}><n.icon size={17} />{n.label}</Link>)}</nav><span className="admin-nav-label">INSIGHTS & SETUP</span><nav>{nav.slice(9).map(n => <Link to={n.to} key={n.label} activeProps={{ className: 'active' }} activeOptions={{ exact: true }} onClick={() => setMenu(false)}><n.icon size={17} />{n.label}</Link>)}</nav><button className="admin-store-link as-button" onClick={() => { adminLogout(); void logout(); navigate({ to: '/admin/login' }); }}>Sign out <LogOut size={16} /></button><Link className="admin-store-link" to="/">View storefront <ArrowUpRight size={16} /></Link></aside><div className="admin-main"><header className="admin-topbar"><Button variant="tool" className="admin-menu" aria-label="Toggle admin menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Menu /></Button><div className="admin-breadcrumb">Brand Studio <span>/</span> {title}</div><div className="admin-top-tools"><Button variant="tool" aria-label="Notifications" aria-expanded={notifications} aria-haspopup="dialog" onClick={() => setNotifications(!notifications)}><Bell />{(low + out) > 0 && <span className="counter">{low + out}</span>}</Button><span className="admin-avatar">HG</span></div>{notifications && <div className="notification-panel" role="dialog" aria-label="Notifications"><h3>Notifications</h3>{out > 0 && <p>{out} product{out > 1 ? 's' : ''} out of stock</p>}{low > 0 && <p>{low} product{low > 1 ? 's' : ''} running low</p>}{low + out === 0 && <p>All stocked up. Looking good.</p>}<Button variant="link" size="sm" onClick={() => { setNotifications(false); navigate({ to: '/admin/inventory' }); }}>View inventory</Button></div>}</header>{menu && <div className="sidebar-scrim" onClick={() => setMenu(false)} aria-hidden="true" />}<main className="admin-content">{children}</main></div></div>;
}
function PageHead({ eyebrow, h1, sub, children }: { eyebrow?: string; h1: string; sub?: string; children?: ReactNode }) {
  return <div className="admin-page-title"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{h1}</h1>{sub && <p>{sub}</p>}</div><div className="admin-actions">{children}</div></div>;
}
function money0(n: number) { return money(Math.round(n * 100) / 100); }

// --- overview -------------------------------------------------------------------
export function AdminOverview() {
  const [orders, setOrders] = useState<Order[]>([]);
  useEffect(() => { listOrders().then(setOrders); }, []);
  const reload = () => { listOrders().then(setOrders); };
  const live = orders.filter(o => o.status !== 'Cancelled');
  const revenue = live.reduce((n, o) => n + o.total, 0);
  const aov = live.length ? revenue / live.length : 0;
  const active = products.filter(p => (p.status ?? 'Active') === 'Active').length;
  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (13 - i)); return d.toISOString().slice(0, 10); });
  const byDay = days.map(d => live.filter(o => o.createdAt.slice(0, 10) === d).reduce((n, o) => n + o.total, 0));
  const max = Math.max(1, ...byDay);
  const cod = live.filter(o => o.payment === 'cod').length;
  const bank = live.filter(o => o.payment === 'bank').length;
  const sold = new Map<string, { name: string; qty: number; rev: number; image: string }>();
  for (const o of live) for (const it of o.items) {
    const s = sold.get(it.productId) ?? { name: it.name, qty: 0, rev: 0, image: it.image };
    s.qty += it.qty; s.rev += it.qty * it.price; sold.set(it.productId, s);
  }
  const top = [...sold.values()].sort((a, b) => b.rev - a.rev).slice(0, 4);
  const lowStock = products.filter(p => totalStock(p) <= lowAt());
  return <AdminLayout title="Overview"><PageHead eyebrow={new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()} h1="Your brand, at a glance." sub="Live numbers from your store." />
    <div className="metric-grid">{[['Revenue', money0(revenue), `${live.length} orders`], ['Orders', String(live.length), `${bank} bank · ${cod} COD`], ['Average order value', money0(aov), 'per order'], ['Active products', String(active), `${products.length - active} in draft`]].map(([label, value, trend]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong><small>{trend}</small></div>)}</div>
    <div className="admin-chart-layout"><section className="admin-panel"><div className="admin-panel-title"><h2>Sales — last 14 days</h2><span>{money0(revenue)} total</span></div><div className="sales-chart">{byDay.map((v, i) => <div key={i} className="chart-column" title={`${days[i]}: ${money0(v)}`}><div className="chart-fill" style={{ height: `${Math.max(3, (v / max) * 100)}%` }} /></div>)}</div><div className="chart-axis"><span>{days[0]?.slice(5) ?? ''}</span><span>{days[6]?.slice(5) ?? ''}</span><span>{days[13]?.slice(5) ?? ''}</span></div></section>
      <section className="admin-panel"><div className="admin-panel-title"><h2>Best sellers</h2><Link to="/admin/products">View all products →</Link></div>{top.length === 0 ? <p className="fine-print">No item-level sales yet — new checkout orders appear here.</p> : top.map(p => <div className="admin-best" key={p.name}><img src={p.image} alt="" /><div><strong>{p.name}</strong><small>{p.qty} units sold</small></div><span>{money0(p.rev)}</span></div>)}</section></div>
    <section className="admin-panel"><div className="admin-panel-title"><h2>Recent orders</h2><Link to="/admin/orders">View all orders →</Link></div><AdminOrdersTable compact onChange={reload} /></section>
    {lowStock.length > 0 && <div className="admin-insights"><p><Package size={18} /><strong>{lowStock.length} piece{lowStock.length > 1 ? 's' : ''} running low.</strong> {lowStock.slice(0, 3).map(p => p.name).join(' · ')}</p><Link to="/admin/inventory" className="text-link">RESTOCK →</Link></div>}</AdminLayout>;
}

// --- orders ---------------------------------------------------------------------
export function AdminOrdersTable({ compact, onChange }: { compact?: boolean; onChange?: () => void }) {
  const [detail, setDetail] = useState<string | null>(null);
  const [acted, setActed] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderDetail, setOrderDetail] = useState<Order | undefined>(undefined);
  const [q, setQ] = useState(''); const [status, setStatus] = useState('all'); const [pay, setPay] = useState('all');
  useEffect(() => { listOrders().then(setOrders); }, []);
  useEffect(() => { if (!detail) { setOrderDetail(undefined); return; } getOrder(detail).then((o) => setOrderDetail(o ?? undefined)); }, [detail]);
  const refresh = () => { listOrders().then(setOrders); if (detail) getOrder(detail).then((o) => setOrderDetail(o ?? undefined)); onChange?.(); };
  const order = orderDetail;
  const rows = orders.filter(o => (status === 'all' || o.status === status) && (pay === 'all' || o.payment === pay) && (!q || (o.id + o.customer + o.email).toLowerCase().includes(q.toLowerCase())));
  const shown = compact ? rows.slice(0, 5) : rows;
  return <>{!compact && <div className="admin-filter"><label><Search size={17} /><input aria-label="Search orders" placeholder="Search order, customer, email…" value={q} onChange={e => setQ(e.target.value)} /></label><select aria-label="Order status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option><option>Awaiting payment proof</option><option>Order received</option>{PIPELINE.map(s => <option key={s}>{s}</option>)}<option>Cancelled</option></select><select aria-label="Payment method" value={pay} onChange={e => setPay(e.target.value)}><option value="all">All payments</option><option value="cod">Cash on delivery</option><option value="bank">Bank transfer</option></select></div>}
    <div className="table-scroll"><table className="admin-table"><thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Date</th><th scope="col">Payment</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col" /></tr></thead><tbody>{shown.map(o => <tr key={o.id}><td>{o.id}</td><td>{o.customer}<small className="table-small">{o.email}</small></td><td>{new Date(o.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td><td><span className={`status-tag ${o.paymentStatus === 'Paid' ? 'done' : 'pending'}`}>{o.payment === 'cod' ? 'COD' : `Bank · ${o.paymentStatus}`}</span></td><td><span className={`status-tag ${o.status === 'Delivered' ? 'done' : o.status === 'Cancelled' ? 'cancelled' : 'pending'}`}>{o.status}</span></td><td>{money0(o.total)}</td><td><Button variant="tool" aria-label={`View ${o.id}`} onClick={() => setDetail(o.id)}><ArrowUpRight size={15} /></Button></td></tr>)}</tbody></table></div>
    {shown.length === 0 && <p className="fine-print">No orders match these filters.</p>}
    <Dialog open={!!detail} onOpenChange={() => { setDetail(null); setActed(false); setReceiptBusy(false); }}><DialogContent className="order-dialog">{order && <><DialogTitle>Order {order.id}</DialogTitle><DialogDescription>{order.customer} · {order.email} · {new Date(order.createdAt).toLocaleString('en-GB')}</DialogDescription>
      <p><strong>{PAYMENT_LABEL[order.payment]}</strong> — {order.paymentStatus}{order.transferRef && <> · Ref: <code>{order.transferRef}</code> <Button variant="link" size="sm" onClick={() => { try { navigator.clipboard.writeText(order.transferRef ?? ''); toast.success('Transfer reference copied.'); } catch { toast.error('Copy failed.'); } }}>Copy reference</Button></>}</p>
      {order.transfer_proof_url && <p><Button variant="link" size="sm" disabled={receiptBusy} onClick={() => { const path = order.transfer_proof_url ?? ''; if (!path || receiptBusy) return; if (path.startsWith('data:')) { window.open(path, '_blank'); return; } const sb = getSupabase(); if (!sb) { window.open(path, '_blank'); return; } setReceiptBusy(true); void sb.storage.from(TRANSFER_BUCKET).createSignedUrl(path, 3600).then(({ data, error }) => { if (error || !data?.signedUrl) { toast.error(error?.message || 'Could not open the receipt.'); return; } window.open(data.signedUrl, '_blank', 'noopener'); }).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Could not open the receipt.')).finally(() => setReceiptBusy(false)); }}>{receiptBusy ? 'OPENING RECEIPT…' : 'VIEW TRANSFER RECEIPT'}</Button></p>}
      <p>{order.address.street}, {order.address.city} {order.address.postcode}{order.address.phone && ` · ${order.address.phone}`}</p>
      <div className="order-items">{order.items.length === 0 ? <p className="fine-print">Seeded demo order — item lines unavailable.</p> : order.items.map((it, i) => <p key={i}>{it.name} · {it.colour} · {it.size} × {it.qty} — {money0(it.price * it.qty)}</p>)}</div>
      {order.discount > 0 && <p>Discount {order.discountCode}: −{money0(order.discount)}</p>}
      <p><strong>Total: {money0(order.total)}</strong> <small className="table-small">incl. {order.shipping.method} ({order.shipping.price === 0 ? 'FREE' : money0(order.shipping.price)})</small></p>
      <ol className="timeline small">{order.timeline.map((t, i) => <li key={i} className={i === order.timeline.length - 1 ? 'current' : 'done'}><span className="dot" />{t.status}<small> · {new Date(t.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></li>)}</ol>
      {order.status !== 'Cancelled' && order.status !== 'Delivered' && (() => { const next = nextStatuses(order); const locked = order.payment === 'bank' && order.paymentStatus !== 'Paid'; const upcoming = PIPELINE.filter((s) => !next.includes(s) && s !== order.status); return <><label className="form-field">Move to status<select value="" onChange={e => { const s = e.target.value as OrderStatus; if (!s) return; const sel = e.target; void (async () => { if (s === 'Cancelled') { if (!window.confirm(`Cancel order ${order.id}?`)) { sel.value = ''; return; } await cancelOrder(order.id); toast.success(`Order ${order.id} cancelled.`); } else { await setOrderStatus(order.id, s); toast.success(`Order ${order.id} → ${s}.`); } refresh(); })(); }}><option value="">Choose next step…</option>{next.map(s => <option key={s} value={s}>{s}</option>)}{locked && upcoming.map(s => <option key={s} value={s} disabled>{s} — approve payment first</option>)}</select></label>{locked && <p className="fine-print">Bank transfer pending — approve the payment above to unlock packing steps.</p>}</>; })()}
        {order.payment === 'bank' && order.paymentStatus !== 'Paid' && <Button variant="fashion" disabled={acted} onClick={() => { if (acted) return; setActed(true); void approvePayment(order.id).then(() => { toast.success(`Payment approved — order ${order.id} is now Received.`); refresh(); }); }}><Check size={14} /> {acted ? 'APPROVED' : 'APPROVE PAYMENT'}</Button>}
    </>}</DialogContent></Dialog></>;
}
export function AdminOrders() {
  return <AdminLayout title="Orders"><PageHead h1="Orders" sub="Payments, packing and delivery — every order, one clear view."><Button variant="quiet" onClick={() => { listOrders().then((ls) => downloadCSV('huda-orders', ls.map((o) => ({ id: o.id, email: o.email, customer: o.customer, date: o.createdAt.slice(0, 10), items: o.items.map((it) => `${it.name} ${it.size}x${it.qty}`).join('; '), subtotal: o.subtotal, discount: o.discount, shipping: o.shipping.price, total: o.total, payment: o.payment, paymentStatus: o.paymentStatus, status: o.status })))); }}>EXPORT CSV</Button><Button variant="fashion" asChild><Link to="/admin/orders/new"><Plus size={14}/> NEW ORDER</Link></Button></PageHead><section className="admin-panel"><AdminOrdersTable /></section></AdminLayout>;
}

// --- products -------------------------------------------------------------------
function blankStock(): Record<string, number> {
  return Object.fromEntries(sizes.map(s => [s, 25]));
}
export function AdminProducts({ initialQuery }: { initialQuery: string | undefined }) {
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState(initialQuery ?? ''); const [cat, setCat] = useState('all'); const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<'draft' | 'delete' | null>(null);
  void tick;
  const cats = ['all', ...Array.from(new Set(products.map(p => p.category)))];
  const rows = products.filter(p => (!q || (p.name + ' ' + p.colour).toLowerCase().includes(q.toLowerCase())) && (cat === 'all' || p.category === cat) && (status === 'all' || (p.status ?? 'Active') === status));
  function refresh() { setTick(t => t + 1); setSelected([]); }
  return <AdminLayout title="Products"><PageHead h1="Products" sub={`${products.length} pieces in your collection.`}><Button variant="quiet" onClick={() => downloadCSV('huda-products', products.map((p) => ({ id: p.id, name: p.name, category: p.category, colour: p.colour, price: p.price, salePrice: p.salePrice ?? '', badge: p.badge ?? '', status: p.status ?? 'Active', stock: totalStock(p) })))}>EXPORT CSV</Button><Button variant="fashion" onClick={() => setEditing('new')}><Plus size={14} /> ADD PRODUCT</Button></PageHead>
    <section className="admin-panel"><div className="admin-filter"><label><Search size={17} /><input aria-label="Search products" placeholder="Search products…" value={q} onChange={e => setQ(e.target.value)} /></label><select aria-label="Category" value={cat} onChange={e => setCat(e.target.value)}>{cats.map(c => <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>)}</select><select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option><option>Active</option><option>Draft</option></select>{selected.length > 0 && <><span>{selected.length} selected</span><Button variant="quiet" onClick={() => setConfirmBulk('draft')}>Set to draft</Button><Button variant="quiet" onClick={() => setConfirmBulk('delete')}>Delete {selected.length} selected</Button></>}</div>
      <div className="table-scroll"><table className="admin-table"><thead><tr><th scope="col"><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && selected.length === rows.length} onChange={e => setSelected(e.target.checked ? rows.map(p => p.id) : [])} /></th><th scope="col">Product</th><th scope="col">Status</th><th scope="col">Inventory</th><th scope="col">Category</th><th scope="col">Price</th><th scope="col">Actions</th></tr></thead><tbody>{rows.map(p => <tr key={p.id}><td><input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.includes(p.id)} onChange={() => setSelected(s => s.includes(p.id) ? s.filter(i => i !== p.id) : [...s, p.id])} /></td><td><div className="admin-product-cell"><img src={productImage(p)} alt="" /><span>{p.name}<small>{p.colour} · {productColours(p).length} colour{productColours(p).length > 1 ? 's' : ''}</small></span></div></td><td><span className={`status-tag ${(p.status ?? 'Active') === 'Active' ? 'done' : 'neutral'}`}>{p.status ?? 'Active'}</span></td><td>{totalStock(p)} units<small className="table-small">{sizes.map(s => `${s}:${sizeStock(p, s)}`).join(' · ')}</small></td><td>{p.category}</td><td>{p.salePrice ? <><del>{money(p.price)}</del> {money(p.salePrice)}</> : money(p.price)}</td><td><div className="admin-actions"><Button variant="tool" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}><Pencil size={15} /></Button><Button variant="tool" aria-label={`Delete ${p.name}`} onClick={() => setConfirmDel(p.id)}><Trash2 size={15} /></Button></div></td></tr>)}</tbody></table></div>{rows.length===0&&<p className="fine-print">No products match these filters — try clearing the search or add a new product.</p>}</section>
    <Dialog open={editing !== null} onOpenChange={() => setEditing(null)}><DialogContent className="editor-dialog">{editing && <ProductEditor key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} onSaved={() => { setEditing(null); refresh(); }} onClose={() => setEditing(null)} />}</DialogContent></Dialog>
    <Dialog open={!!confirmDel} onOpenChange={() => setConfirmDel(null)}><DialogContent><DialogTitle>Delete this product?</DialogTitle><DialogDescription>It will disappear from the storefront immediately. Orders already placed keep their lines.</DialogDescription><div className="admin-actions"><Button variant="quiet" onClick={() => setConfirmDel(null)}>KEEP IT</Button><Button variant="fashion" onClick={async () => { if (confirmDel) await deleteProduct(confirmDel); setConfirmDel(null); refresh(); toast.success('Product deleted.'); }}>DELETE</Button></div></DialogContent></Dialog>
    <Dialog open={confirmBulk !== null} onOpenChange={() => setConfirmBulk(null)}><DialogContent><DialogTitle>{confirmBulk === 'delete' ? `Delete ${selected.length} products?` : `Move ${selected.length} products to draft?`}</DialogTitle><DialogDescription>{confirmBulk === 'delete' ? 'They will disappear from the storefront immediately. Placed orders keep their lines. This cannot be undone.' : 'They will be hidden from shoppers until re-activated.'} {selected.slice(0, 5).map((id) => getProduct(id)?.name).filter(Boolean).join(' · ')}{selected.length > 5 ? ` · +${selected.length - 5} more` : ''}</DialogDescription><div className="admin-actions"><Button variant="quiet" onClick={() => setConfirmBulk(null)}>CANCEL</Button><Button variant="fashion" onClick={async () => { if (confirmBulk === 'delete') { for (const id of selected) await deleteProduct(id); toast.success(`${selected.length} products deleted.`); } else if (confirmBulk === 'draft') { for (const id of selected) { const p = getProduct(id); if (p) await upsertProduct({ ...p, status: 'Draft' }); } toast.success('Selected products set to draft.'); } setConfirmBulk(null); refresh(); }}>{confirmBulk === 'delete' ? 'DELETE ALL' : 'MOVE TO DRAFT'}</Button></div></DialogContent></Dialog></AdminLayout>;
}

export function ProductEditor({ initial, onSaved, onClose }: { initial: Product | undefined; onSaved: () => void; onClose: () => void }) {
  const busy = useRef(false);
  const [duplicating, setDuplicating] = useState(false);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState(initial?.category ?? 'Leggings');
  const [price, setPrice] = useState(initial?.price ?? 48);
  const [sale, setSale] = useState(initial?.salePrice ?? '');
  const [badge, setBadge] = useState(initial?.badge ?? '');
  const [crop, setCrop] = useState(initial?.crop ?? '');
  const [status, setStatus] = useState<ProductStatus>(initial?.status ?? 'Active');
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [images, setImages] = useState<string[]>(initial?.images?.length ? [...initial.images] : initial ? [initial.image] : []);
  const [url, setUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [colours, setColours] = useState<ProductColour[]>(initial?.colours?.length ? initial.colours.map(c => ({ ...c, images: [...c.images] })) : initial ? [{ name: initial.colour, tone: initial.tone, images: [initial.image] }] : []);
  const [presetQ, setPresetQ] = useState('');
  const [customName, setCustomName] = useState(''); const [customHex, setCustomHex] = useState('#8a8a8a'); const [customTone, setCustomTone] = useState('onyx');
  const [stock, setStock] = useState<Record<string, number>>(() => { const m: Record<string, number> = {}; sizes.forEach(s => { m[s] = initial ? sizeStock(initial, s) : 25; }); return m; });
  const totalImages = new Set(images).size;
  const usedImages = new Set(colours.flatMap(c => c.images));
  const orphanImages = images.filter(src => !usedImages.has(src));
  const imageless = colours.filter(c => !c.images.length);
  const catOptions = listCategories().map(c => c.name);
  const families = [...new Set(COLOUR_PRESETS.map(p => p.tone))];
  const shownPresets = COLOUR_PRESETS.filter(p => p.name.toLowerCase().includes(presetQ.trim().toLowerCase()));
  function addColour(name: string, tone: string, hex?: string) {
    const clean = name.trim();
    if (!clean) return;
    if (colours.some(c => c.name.toLowerCase() === clean.toLowerCase())) { toast.info(`${clean} is already added.`); return; }
    const free = images.find(src => ![...usedImages, ...colours.flatMap(c => c.images)].includes(src));
    setColours(cs => [...cs, { name: clean, tone, images: free ? [free] : [], ...(hex ? { hex } : {}) }]);
  }
  function assignImage(i: number, src: string) {
    // Toggle: clicking the linked image again unlinks it (falls back to cover).
    setColours(cs => cs.map((c, n) => n === i ? { ...c, images: c.images.includes(src) ? [] : [src] } : c));
  }
  function addUrl() {
    if (!url.trim()) { toast.error('Paste an image URL first — or pick from the gallery above.'); return; }
    if (totalImages >= 6) { toast.error('Maximum 6 images per product.'); return; }
    if (!images.includes(url.trim())) setImages(im => [...im, url.trim()]);
    setUrl('');
  }
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || uploading) return;
    if (totalImages >= 6) { toast.error('Maximum 6 images per product.'); return; }
    setUploading(true);
    setUploadMsg('');
    // Supabase Storage when connected; otherwise a browser-local WebP so the
    // upload button always works (demo data stays in this browser only).
    const job = isStorageReady ? uploadProductImage(f) : fileToWebPDataUrl(f);
    void job.then(({ url: src, savedPct, kb }) => {
      setImages(im => (im.includes(src) ? im : [...im, src]));
      setUploadMsg(`Uploaded as WebP — ${kb}KB (${savedPct}% smaller than the original).${isStorageReady ? '' : ' Demo only: connect Supabase Storage to sync everywhere.'}`);
      toast.success('Image uploaded.');
    }).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Upload failed.'))
      .finally(() => setUploading(false));
  }
  function moveImg(i: number, dir: -1 | 1) {
    setImages(im => { const n = [...im]; const j = i + dir; if (j < 0 || j >= n.length) return n;[n[i], n[j]] = [n[j]!, n[i]!]; return n; });
  }
  function delImg(src: string) {
    setImages(im => im.filter(i => i !== src));
    setColours(cs => cs.map(c => ({ ...c, images: c.images.filter(i => i !== src) })));
    void deleteProductImage(src);
  }
  async function duplicate() {
    if (!initial || duplicating) return;
    setDuplicating(true);
    const copy: Product = { ...initial, id: `${initial.id}-copy-${Date.now().toString(36)}`, name: `${initial.name} (Copy)`, status: 'Draft' };
    await upsertProduct(copy);
    toast.success('Duplicated as a draft.');
    onSaved();
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 3) { toast.error('Give the product a name (3+ characters).'); return; }
    if (price <= 0) { toast.error('Price must be above zero.'); return; }
    const saleNum = sale === '' ? undefined : Number(sale);
    if (saleNum != null && !(saleNum > 0 && saleNum < price)) { toast.error('Sale price must be below the regular price.'); return; }
    const cleanColours = colours.filter(c => c.name.trim()).map(c => {
      const preset = presetFor(c.name);
      return { name: c.name.trim(), tone: c.tone, images: c.images.length ? [...c.images] : images.slice(0, 1), ...(c.hex ?? preset?.hex ? { hex: (c.hex ?? preset?.hex) as string } : {}) };
    });
    const imgs = images.length ? [...images] : cleanColours[0]?.images ?? [];
    if (!imgs.length) { toast.error('Add at least one product image.'); return; }
    if (!cleanColours.length) { toast.error('Add at least one colour.'); return; }
    const primary = cleanColours[0]!;
    if (busy.current) return;
    busy.current = true;
    const id = initial?.id ?? slugify(name);
    const p: Product = {
      id, name: name.trim(), category,
      colour: primary.name, tone: primary.tone,
      price,
      image: imgs[0]!, images: imgs,
      stockBySize: { ...stock }, status, sku: sku.trim() || `HG-${slugify(name).slice(0, 5).toUpperCase()}`,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(saleNum != null ? { salePrice: saleNum } : {}),
      ...(badge ? { badge } : {}),
      ...(crop ? { crop } : {}),
      colours: cleanColours,
    };
    await upsertProduct(p);
    toast.success(initial ? 'Product updated across the store.' : 'Product added to the store.');
    onSaved();
  }
  const preview: Product = { id: 'preview', name: name.trim() || 'Product name', category, colour: colours[0]?.name ?? '', tone: colours[0]?.tone ?? 'onyx', price: price || 0, image: images[0] ?? '', images, colours, ...(sale !== '' ? { salePrice: Number(sale) } : {}), ...(badge ? { badge } : {}) };
  return <form onSubmit={save}>
    <div className="editor-bar"><div><button type="button" className="text-link" onClick={onClose}>← ALL PRODUCTS</button><DialogTitle>{initial ? 'Edit product' : 'Add product'}</DialogTitle></div><div className="admin-actions"><span className={`status-tag ${status === 'Active' ? 'done' : ''}`}>{status}</span>{initial && <Button variant="quiet" type="button" disabled={duplicating} onClick={duplicate}><Copy size={14} /> {duplicating ? 'DUPLICATING…' : 'DUPLICATE'}</Button>}</div></div>
    <DialogDescription>Title, media, colours, price and sizes — live on the storefront after saving.</DialogDescription>
    <section className="admin-panel"><h2>1 · Title & description</h2><div className="form-grid"><label className="form-field full">Product name<input value={name} onChange={e => setName(e.target.value)} required /></label><p className="fine-print full">URL handle: /product/{slugify(name) || '…'}</p><label className="form-field full">Description<textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Designed for confident movement…" /><span className="fine-print">Shown on the product page under the product name.</span></label></div></section>
    <section className="admin-panel"><h2>2 · Media ({totalImages}/6)</h2>{images.length === 0 && <p className="fine-print">No images yet — upload from your device or paste a URL below.</p>}<div className="media-grid">{images.map((src, i) => <span key={src + i} className={`media-cell ${i === 0 ? 'cover' : ''}`}><img src={src} alt="" />{i === 0 && <em><Star size={11} /> Cover</em>}<span className="media-tools"><button type="button" aria-label={`Move image ${i + 1} of ${images.length} left`} disabled={i === 0} onClick={() => moveImg(i, -1)}>←</button><button type="button" aria-label={`Move image ${i + 1} of ${images.length} right`} disabled={i === images.length - 1} onClick={() => moveImg(i, 1)}>→</button><button type="button" aria-label={`Remove image ${i + 1} of ${images.length}`} onClick={() => delImg(src)}><X size={12} /></button></span></span>)}</div>
      <div className="image-add"><label className="form-field">Or upload from this device (auto-converts to WebP){!isStorageReady && ' — demo: saved in this browser only'}<span className="url-row"><input type="file" accept="image/*" onChange={onFile} disabled={uploading} aria-label="Upload product image" />{uploading && <span className="fine-print">Uploading…</span>}</span>{uploadMsg && <span className="field-ok">{uploadMsg}</span>}</label><label className="form-field">Or paste an image URL (Supabase public URL ready)<span className="url-row"><input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /><Button variant="quiet" type="button" onClick={addUrl}><ImagePlus size={14} /> ADD IMAGE</Button></span></label></div></section>
    <section className="admin-panel"><h2>3 · Colours ({colours.length})</h2><label className="form-field">Find a colour<input value={presetQ} onChange={e => setPresetQ(e.target.value)} placeholder="Search 29 ready colours… (sage, navy, rust…)" /></label>
      {families.map(f => { const list = shownPresets.filter(x => x.tone === f); if (!list.length) return null; return <div key={f}><p className="preset-family">{f}</p><div className="preset-grid">{list.map(x => { const added = colours.some(c => c.name.toLowerCase() === x.name.toLowerCase()); return <button key={x.name} type="button" className={`preset-chip ${added ? 'added' : ''}`} title={x.name} aria-pressed={added} onClick={() => addColour(x.name, x.tone, x.hex)}><span className="preset-dot" style={{ background: x.hex }} />{x.name}{added && <Check size={12} />}</button>; })}</div></div>; })}
      <div className="custom-colour"><strong>Custom colour</strong><div className="colour-row"><label className="form-field">Name<input value={customName} onChange={e => { setCustomName(e.target.value); setCustomTone(guessTone(e.target.value)); }} placeholder="Forest Night" /></label><label className="form-field">Shade<input type="color" value={customHex} onChange={e => setCustomHex(e.target.value)} /></label><label className="form-field">Family<select value={customTone} onChange={e => setCustomTone(e.target.value)}>{[...new Set(COLOUR_PRESETS.map(x => x.tone))].map(t => <option key={t}>{t}</option>)}</select></label><Button variant="quiet" type="button" disabled={!customName.trim()} onClick={() => { addColour(customName, customTone, customHex); setCustomName(''); }}><Plus size={14} /> ADD COLOUR</Button></div></div>
      {colours.length === 0 && <p className="field-error">Add at least one colour above.</p>}
      {colours.map((c, i) => <div key={i} className="colour-card"><div className="colour-card-head"><span className="preset-dot" style={{ background: c.hex ?? '#ccc' }} /><strong>{c.name || 'Unnamed colour'}</strong><small>{c.tone}</small><span className="spacer" /><Button variant="tool" type="button" aria-label="Duplicate colour" onClick={() => setColours(cs => [...cs, { ...c, name: `${c.name} Alt`, images: [...c.images] }])}><Copy size={14} /></Button><Button variant="tool" type="button" aria-label="Remove colour" onClick={() => setColours(cs => cs.filter((_, n) => n !== i))}><Trash2 size={14} /></Button></div><p className="fine-print">Tap its image below{c.images.length ? '' : ' — none linked yet'}:</p><div className="thumb-pick">{images.map(src => <button key={src} type="button" className={`thumb ${c.images.includes(src) ? 'selected' : ''}`} aria-label={`Use this image for ${c.name || 'colour'}`} aria-pressed={c.images.includes(src)} onClick={() => assignImage(i, src)}><img src={src} alt="" />{c.images.includes(src) && <Check size={14} />}</button>)}{images.length === 0 && <span className="fine-print">Add media first (section 2).</span>}</div></div>)}
      {(orphanImages.length > 0 || imageless.length > 0) && <p className="field-warn">{orphanImages.length > 0 && `${orphanImages.length} image${orphanImages.length > 1 ? 's' : ''} not linked to any colour. `}{imageless.length > 0 && `${imageless.length} colour${imageless.length > 1 ? 's' : ''} without image (uses cover).`}</p>}</section>
    <section className="admin-panel"><h2>4 · Pricing</h2><div className="form-grid"><label className="form-field">Price (£)<input type="number" min={0} step={0.01} value={price} onChange={e => setPrice(Math.max(0, num(e.target.value)))} required /></label><label className="form-field">Compare-at price (£)<input type="number" min={0} step={0.01} value={sale} placeholder="No sale" onChange={e => setSale(e.target.value === '' ? '' : Math.max(0, num(e.target.value)))} /></label></div>{sale !== '' && Number(sale) > 0 && Number(sale) < price ? <p className="field-ok">Shows as <del>{money(price)}</del> {money(Number(sale))} + SALE badge.</p> : <p className="fine-print">Set a lower compare-at price to trigger the sale look.</p>}</section>
    <section className="admin-panel"><h2>5 · Inventory</h2><div className="form-grid"><label className="form-field">SKU<input value={sku} onChange={e => setSku(e.target.value)} placeholder="auto" /></label></div><div className="stock-matrix">{sizes.map(s => <label key={s} className="form-field">{s}<input type="number" min={0} value={stock[s] ?? 0} onChange={e => setStock(m => ({ ...m, [s]: Math.max(0, num(e.target.value)) }))} /></label>)}</div><p className="fine-print">Zero everywhere hides the product from shoppers (status stays).</p></section>
    <section className="admin-panel"><h2>6 · Organization</h2><div className="form-grid"><label className="form-field">Category<select value={category} onChange={e => setCategory(e.target.value)}>{[...new Set([...catOptions, category])].map(c => <option key={c}>{c}</option>)}</select></label><label className="form-field">Badge<select value={badge} onChange={e => setBadge(e.target.value)}><option value="">No badge</option>{badges.map(b => <option key={b}>{b}</option>)}</select></label><label className="form-field">Photo style<select value={crop} onChange={e => setCrop(e.target.value)}><option value="">Standard</option><option value="leggings">Leggings crop</option><option value="bra">Top crop</option></select></label><label className="form-field">Status<select value={status} onChange={e => setStatus(e.target.value as ProductStatus)}><option>Active</option><option>Draft</option></select></label></div></section>
    <section className="admin-panel"><h2>7 · Store preview</h2><div className="preview-mini"><div className="product-photo"><img src={preview.image} alt="" />{preview.badge && <span className="product-badge">{preview.badge}</span>}</div><div className="product-info"><span>{preview.name}</span><span>{preview.salePrice ? <><del>{money(preview.price)}</del> {money(preview.salePrice)}</> : money(preview.price)}</span></div><p className="product-colour">{preview.colour || '—'}{colours.length > 1 && ` · ${colours.length} colours`}</p><div className="swatches">{colours.slice(0, 4).map(c => <span key={c.name} title={c.name} className={`swatch ${c.tone}`} style={c.hex ? { background: c.hex } : undefined} />)}</div></div></section>
    <div className="editor-foot"><Button variant="fashion" type="submit">SAVE PRODUCT</Button></div></form>;
}

// --- inventory ------------------------------------------------------------------
export function AdminInventory() {
  const [tick, setTick] = useState(0);
  void tick;
  const [drafts, setDrafts] = useState<Record<string, Record<string, number>>>({});
  void drafts;
  function setDraft(id: string, size: string, v: number) {
    const safe = Number.isFinite(v) ? Math.max(0, v) : 0;
    setDrafts(d => ({ ...d, [id]: { ...Object.fromEntries(sizes.map(s => [s, sizeStock(getProduct(id)!, s)])), ...(d[id] ?? {}), [size]: safe } }));
  }
  function save(id: string) {
    const p = getProduct(id); if (!p) return;
    const base = drafts[id] ?? {};
    void upsertProduct({ ...p, stockBySize: { ...Object.fromEntries(sizes.map(s => [s, sizeStock(p, s)])), ...base } });
    setDrafts(d => { const n = { ...d }; delete n[id]; return n; });
    setTick(t => t + 1);
    toast.success(`${p.name} stock updated.`);
  }
  const low = products.filter(p => totalStock(p) <= lowAt());
  return <AdminLayout title="Inventory"><PageHead h1="Inventory" sub="Size-level stock across the collection." />
    {low.length > 0 && <section className="admin-panel warn"><h2>Needs attention ({low.length})</h2>{low.map(p => <div key={p.id} className="manage-row"><div><strong>{p.name}</strong><small>{totalStock(p) === 0 ? 'Out of stock' : `Only ${totalStock(p)} left`}</small></div><Link to="/admin/products" search={{ q: p.name }} className="text-link">EDIT →</Link></div>)}</section>}
    <section className="admin-panel"><div className="table-scroll"><table className="admin-table"><thead><tr><th scope="col">Product</th>{sizes.map(s => <th key={s}>{s}</th>)}<th>Total</th><th scope="col" /></tr></thead><tbody>{products.map(p => <tr key={p.id}><td><div className="admin-product-cell"><img src={productImage(p)} alt="" /><span>{p.name}</span></div></td>{sizes.map(s => { const v = drafts[p.id]?.[s] ?? sizeStock(p, s); return <td key={s}><input className={`stock-input ${v === 0 ? 'zero' : v <= lowAt() ? 'low' : ''}`} type="number" min={0} value={v} onChange={e => { if (e.target.value.trim() === '') return; setDraft(p.id, s, Number(e.target.value)); }} aria-label={`${p.name} ${s} stock`} /></td>; })}<td><strong>{sizes.reduce((n, s) => n + (drafts[p.id]?.[s] ?? sizeStock(p, s)), 0)}</strong></td><td>{drafts[p.id] && <Button variant="quiet" size="sm" onClick={() => save(p.id)}>Save</Button>}</td></tr>)}</tbody></table></div></section></AdminLayout>;
}

// --- categories -------------------------------------------------------------------
export function AdminCategories() {
  const [list, setList] = useState(listCategories);
  const [name, setName] = useState('');
  const [formError, setFormError] = useState('');
  function persist(next: typeof list) { saveCategories(next); setList(listCategories()); }
  function move(i: number, dir: -1 | 1) {
    const n = [...list]; const j = i + dir; if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j]!, n[i]!];
    persist(n.map((c, order) => ({ ...c, order })));
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    // Never a dead click: every submit explains itself inline.
    if (n.length < 2) { setFormError('Type a category name (2+ characters).'); return; }
    if (list.some(c => c.name.toLowerCase() === n.toLowerCase())) { setFormError(`“${n}” already exists — pick another name.`); return; }
    setFormError('');
    persist([...list, { name: n, visible: false, order: list.length }]);
    setName('');
    toast.success(`${n} added — assign products to make it appear.`);
  }
  return <AdminLayout title="Categories"><PageHead h1="Categories" sub="Visibility and order drive the shop tabs and navigation." />
    <section className="admin-panel">{list.map((c, i) => <div key={c.name} className="manage-row"><div><strong>{c.name}</strong><small>{products.filter(p => p.category === c.name).length} products · {c.visible ? 'Shown in shop tabs' : 'Hidden'}</small></div><div className="admin-actions"><Button variant="tool" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button><Button variant="tool" aria-label={`Move ${c.name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</Button><Button variant={c.visible ? 'quiet' : 'fashion'} size="sm" onClick={() => persist(list.map(x => x.name === c.name ? { ...x, visible: !x.visible } : x))}>{c.visible ? 'HIDE' : 'SHOW'}</Button></div></div>)}
      <form className="url-row mt-6" onSubmit={submit}><input value={name} onChange={e => { setName(e.target.value); if (formError) setFormError(''); }} placeholder="New category name…" aria-label="New category name" /><Button variant="fashion" type="submit"><Plus size={14} /> ADD CATEGORY</Button></form>{formError && <p className="field-error mt-6" role="alert">{formError}</p>}</section></AdminLayout>;
}

// --- discounts ----------------------------------------------------------------------
export function AdminDiscounts() {
  const [list, setList] = useState(listDiscounts);
  const [editing, setEditing] = useState<Discount | 'new' | null>(null);
  const [confirmCode, setConfirmCode] = useState<string | null>(null);
  function refresh() { setList(listDiscounts()); }
  return <AdminLayout title="Discounts"><PageHead h1="Discounts" sub="Codes customers apply in the bag and at checkout."><Button variant="quiet" onClick={() => downloadCSV('huda-discounts', listDiscounts())}>EXPORT CSV</Button><Button variant="fashion" onClick={() => setEditing('new')}><Plus size={14} /> ADD CODE</Button></PageHead>
    <section className="admin-panel"><div className="table-scroll"><table className="admin-table"><thead><tr><th scope="col">Code</th><th scope="col">Value</th><th scope="col">Min. spend</th><th scope="col">Uses</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>{list.map(d => <tr key={d.code}><td><strong>{d.code}</strong></td><td>{d.kind === 'percent' ? `${d.value}%` : money(d.value)}</td><td>{d.minSpend > 0 ? money(d.minSpend) : '—'}</td><td>{d.uses}{d.maxUses != null ? ` / ${d.maxUses}` : ''}</td><td><span className={`status-tag ${d.active ? 'done' : 'neutral'}`}>{d.active ? 'Active' : 'Off'}</span></td><td><div className="admin-actions"><Button variant="tool" aria-label={`Edit ${d.code}`} onClick={() => setEditing(d)}><Pencil size={15} /></Button><Button variant="tool" aria-label={`Delete ${d.code}`} onClick={() => setConfirmCode(d.code)}><Trash2 size={15} /></Button></div></td></tr>)}</tbody></table></div>{list.length === 0 && <p className="fine-print">No discount codes yet — create one to reward shoppers.</p>}</section>
    <Dialog open={editing !== null} onOpenChange={() => setEditing(null)}><DialogContent className="dialog-narrow">{editing && <DiscountEditor key={editing === 'new' ? 'new' : editing.code} initial={editing === 'new' ? undefined : editing} onSaved={() => { setEditing(null); refresh(); }} />}</DialogContent></Dialog>
    <Dialog open={!!confirmCode} onOpenChange={() => setConfirmCode(null)}><DialogContent><DialogTitle>Delete code {confirmCode}?</DialogTitle><DialogDescription>Shoppers holding this code will see “not valid” at checkout, even mid-basket. This cannot be undone.</DialogDescription><div className="admin-actions"><Button variant="quiet" onClick={() => setConfirmCode(null)}>KEEP IT</Button><Button variant="fashion" onClick={() => { if (confirmCode) deleteDiscount(confirmCode); setConfirmCode(null); refresh(); toast.success('Code deleted.'); }}>DELETE</Button></div></DialogContent></Dialog></AdminLayout>;
}
export function DiscountEditor({ initial, onSaved }: { initial: Discount | undefined; onSaved: () => void }) {
  const busy = useRef(false);
  const [code, setCode] = useState(initial?.code ?? '');
  const [kind, setKind] = useState<'percent' | 'flat'>(initial?.kind ?? 'percent');
  const [value, setValue] = useState(initial?.value ?? 10);
  const [minSpend, setMinSpend] = useState(initial?.minSpend ?? 0);
  const [maxUses, setMaxUses] = useState(initial?.maxUses == null ? '' : initial.maxUses);
  const [active, setActive] = useState(initial?.active ?? true);
  const [from, setFrom] = useState(initial?.startsAt ?? ''); const [to, setTo] = useState(initial?.endsAt ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (code.trim().length < 3) errs['code'] = 'Use at least 3 characters.';
    if (!(value > 0) || (kind === 'percent' && value > 90)) errs['value'] = kind === 'percent' ? 'Enter a percent between 1 and 90.' : 'Enter an amount above £0.';
    if (from && to && to < from) errs['to'] = 'End date must be after the start date.';
    return errs;
  }
  function save(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    const firstBad = (['code', 'value', 'to'] as const).find((k) => errs[k]);
    if (firstBad) { document.getElementById(`dc-${firstBad}`)?.focus(); return; }
    const c = code.trim().toUpperCase();
    if (busy.current) return;
    busy.current = true;
    if (initial && c !== initial.code) deleteDiscount(initial.code);
    saveDiscount({ code: c, kind, value, minSpend: Math.max(0, minSpend), maxUses: maxUses === '' ? null : Math.max(1, Number(maxUses)), uses: initial && c === initial.code ? initial.uses : 0, active, ...(from ? { startsAt: from } : {}), ...(to ? { endsAt: to } : {}) });
    toast.success(`Code ${c} saved.`); onSaved();
  }
  return <form onSubmit={save} noValidate><DialogTitle>{initial ? `Edit ${initial.code}` : 'New discount code'}</DialogTitle><DialogDescription>Validated live in the bag and at checkout.</DialogDescription>
    <label className="form-field full">Code<input id="dc-code" value={code} onChange={e => { setCode(e.target.value.toUpperCase()); setErrors(x => ({ ...x, code: '' })); }} placeholder="WELCOME10" aria-invalid={!!errors['code']} aria-describedby={errors['code'] ? 'dc-code-err' : undefined} />{errors['code'] && <small className="field-error" id="dc-code-err" role="alert">{errors['code']}</small>}</label>
    <div className="segmented" role="radiogroup" aria-label="Discount type"><button type="button" role="radio" aria-checked={kind === 'percent'} className={kind === 'percent' ? 'on' : ''} onClick={() => setKind('percent')}>Percent %</button><button type="button" role="radio" aria-checked={kind === 'flat'} className={kind === 'flat' ? 'on' : ''} onClick={() => setKind('flat')}>Fixed £</button></div>
    <div className="form-grid"><label className="form-field">Value {kind === 'percent' ? '(%)' : '(£)'}<input id="dc-value" type="number" min={1} value={value} onChange={e => { setValue(Math.max(1, num(e.target.value, 1))); setErrors(x => ({ ...x, value: '' })); }} aria-invalid={!!errors['value']} aria-describedby={errors['value'] ? 'dc-value-err' : undefined} />{errors['value'] && <small className="field-error" id="dc-value-err" role="alert">{errors['value']}</small>}</label>
      <label className="form-field">Min. spend (£)<input type="number" min={0} value={minSpend} onChange={e => setMinSpend(Math.max(0, num(e.target.value)))} /></label></div>
    <div className="form-grid"><label className="form-field">Usage limit<input type="number" min={1} value={maxUses} placeholder="Unlimited" onChange={e => setMaxUses(e.target.value === '' ? '' : Math.max(1, num(e.target.value, 1)))} /></label>
      <label className="form-field">Starts<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label></div>
    <div className="form-grid"><label className="form-field">Ends<input id="dc-to" type="date" value={to} onChange={e => { setTo(e.target.value); setErrors(x => ({ ...x, to: '' })); }} aria-invalid={!!errors['to']} aria-describedby={errors['to'] ? 'dc-to-err' : undefined} />{errors['to'] && <small className="field-error" id="dc-to-err" role="alert">{errors['to']}</small>}</label>
      <div className="active-row"><button type="button" role="switch" aria-checked={active} aria-label="Discount active" className="switch" onClick={() => setActive(!active)}><span className="knob" /></button><div><strong>{active ? 'Active' : 'Off'}</strong><small>{active ? 'Shoppers can use this code now.' : 'Hidden from checkout until turned on.'}</small></div></div></div>
    {code.trim() && <p className="fine-print">Preview: <strong>{code.trim().toUpperCase()}</strong> gives {kind === 'percent' ? `${value}% off` : `${money(value)} off`}{minSpend > 0 && <> on orders over {money(minSpend)}</>}{maxUses !== '' && <> · max {maxUses} uses</>}{!active && <> · currently OFF</>}.</p>}
    <div className="editor-foot"><Button variant="fashion" type="submit">SAVE CODE</Button></div></form>;
}

// --- customers ------------------------------------------------------------------------
export function AdminCustomers() {
  const [tick, setTick] = useState(0);
  const [users, setUsers] = useState<User[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  useEffect(() => { listUsers().then(setUsers); listOrders().then(setOrders); }, [tick]);
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const rows = users.map(u => {
    const mine = orders.filter(o => o.email === u.email);
    return { ...u, orderCount: mine.length, spent: mine.filter(o => o.status !== 'Cancelled').reduce((n, o) => n + o.total, 0), orders: mine };
  }).filter(u => !q || (u.name + u.email).toLowerCase().includes(q.toLowerCase()));
  const current = rows.find(u => u.email === detail);
  return <AdminLayout title="Customers"><PageHead h1="Customers" sub={`${users.length} registered account${users.length === 1 ? '' : 's'} — live from sign-ups.`}><Button variant="quiet" onClick={() => downloadCSV('huda-customers', rows.map((u) => ({ name: u.name, email: u.email, joined: u.createdAt.slice(0, 10), orders: u.orderCount, spent: u.spent, tags: (u.tags ?? []).join('; ') })))}>EXPORT CSV</Button></PageHead>
    <section className="admin-panel"><div className="admin-filter"><label><Search size={16} /><input aria-label="Search customers" placeholder="Search customers…" value={q} onChange={e => setQ(e.target.value)} /></label></div>
      {rows.length === 0 ? <p className="fine-print">No customer accounts yet. New sign-ups appear here automatically.</p> : <div className="table-scroll"><table className="admin-table"><thead><tr><th scope="col">Customer</th><th scope="col">Joined</th><th scope="col">Orders</th><th scope="col">Total spent</th><th scope="col" /></tr></thead><tbody>{rows.map(u => <tr key={u.email}><td>{u.name}<small className="table-small">{u.email}</small>{(u.tags ?? []).length > 0 && <small className="table-tags">{(u.tags ?? []).join(' · ')}</small>}</td><td>{new Date(u.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td><td>{u.orderCount}</td><td>{money(u.spent)}</td><td><Button variant="tool" aria-label={`View ${u.name}`} onClick={() => setDetail(u.email)}><ArrowUpRight size={15} /></Button></td></tr>)}</tbody></table></div>}</section>
    <Dialog open={!!detail} onOpenChange={() => setDetail(null)}><DialogContent>{current && <><DialogTitle>{current.name}</DialogTitle><DialogDescription>{current.email} · customer since {new Date(current.createdAt).toLocaleDateString('en-GB')}</DialogDescription>
      <p><strong>{current.orderCount} orders · {money(current.spent)} lifetime</strong></p>
      {current.addresses.length > 0 && <p>{current.addresses[0]?.street}, {current.addresses[0]?.city} {current.addresses[0]?.postcode}</p>}
      {current.orders.length > 0 ? current.orders.map(o => <p key={o.id}>{o.id} · {o.status} · {money(o.total)}</p>) : <p className="fine-print">No orders placed yet.</p>}<CustomerNotes email={current.email} onChanged={() => setTick((t) => t + 1)} /><div className="admin-actions"><Button variant="link" size="sm" onClick={() => { if (window.confirm(`Delete ${current.name}'s account? Their orders stay in store records.`)) { void deleteAccount(current.email).then((ok) => { if (ok) { setDetail(null); setTick((t) => t + 1); toast.success('Customer account deleted.'); } else toast.error('Could not delete this account.'); }); } }}>Delete account (GDPR)</Button></div></>}</DialogContent></Dialog></AdminLayout>;
}

// --- analytics --------------------------------------------------------------------------
export function AdminAnalytics() {
  const [all, setAll] = useState<Order[]>([]);
  useEffect(() => { listOrders().then(setAll); }, []);
  const orders = all.filter(o => o.status !== 'Cancelled');
  const revenue = orders.reduce((n, o) => n + o.total, 0);
  const aov = orders.length ? revenue / orders.length : 0;
  const byCat = new Map<string, { units: number; rev: number }>();
  for (const o of orders) for (const it of o.items) {
    const p = getProduct(it.productId);
    const cat = p?.category ?? '—';
    const s = byCat.get(cat) ?? { units: 0, rev: 0 };
    s.units += it.qty; s.rev += it.qty * it.price; byCat.set(cat, s);
  }
  const cod = orders.filter(o => o.payment === 'cod').length;
  const bank = orders.filter(o => o.payment === 'bank').length;
  return <AdminLayout title="Analytics"><PageHead h1="Understand your momentum." sub="Computed from real orders — no sample charts." />
    <div className="metric-grid">{[['Revenue', money(revenue)], ['Orders', String(orders.length)], ['Average order value', money(aov)], ['Cash on delivery share', orders.length ? `${Math.round((cod / orders.length) * 100)}%` : '—']].map(([k, v]) => <div className="metric" key={k}><span>{k}</span><strong>{v}</strong></div>)}</div>
    <div className="admin-chart-layout"><section className="admin-panel"><div className="admin-panel-title"><h2>Revenue by category</h2><span>{byCat.size} categories</span></div>{byCat.size === 0 ? <p className="fine-print">Item-level data appears once customers check out.</p> : [...byCat.entries()].sort((a, b) => b[1].rev - a[1].rev).map(([c, s]) => <div className="manage-row" key={c}><div><strong>{c}</strong><small>{s.units} units sold</small></div><strong>{money(s.rev)}</strong></div>)}</section>
      <section className="admin-panel"><div className="admin-panel-title"><h2>Payment split</h2><span>{orders.length} orders</span></div><div className="manage-row"><div><strong>Cash on delivery</strong></div><strong>{cod}</strong></div><div className="manage-row"><div><strong>Bank transfer</strong></div><strong>{bank}</strong></div></section></div></AdminLayout>;
}

// --- settings -----------------------------------------------------------------------------
export function AdminSettings() {
  const s = getSettings();
  const [announcement, setAnnouncement] = useState(s.announcement);
  const [whatsapp, setWhatsapp] = useState(s.whatsapp);
  const [instagram, setInstagram] = useState(s.instagram);
  const [facebook, setFacebook] = useState(s.facebook ?? '');
  const [tiktok, setTiktok] = useState(s.tiktok ?? '');
  const [bankName, setBankName] = useState(s.bankName);
  const [accountName, setAccountName] = useState(s.accountName);
  const [accountNumber, setAccountNumber] = useState(s.accountNumber);
  const [iban, setIban] = useState(s.iban);
  const [shipping, setShipping] = useState(s.shipping?.length ? s.shipping.map((m) => ({ ...m })) : []);
  const [freeOver, setFreeOver] = useState(s.freeOver ?? 100);
  const [lowAtVal, setLowAtVal] = useState(s.lowStockAt ?? 5);
  const [saving, setSaving] = useState(false);
  function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    void updateSettings({ announcement: announcement.trim() || s.announcement, whatsapp: whatsapp.replace(/\D/g, ''), instagram: instagram.trim() || s.instagram, facebook: facebook.trim(), tiktok: tiktok.trim(), bankName: bankName.trim(), accountName: accountName.trim(), accountNumber: accountNumber.trim(), iban: iban.trim(), shipping: shipping.filter((m) => m.label.trim()), freeOver: Math.max(0, freeOver), lowStockAt: Math.max(1, lowAtVal) }).then(() => {
      toast.success('Settings saved — the storefront updates instantly.');
    }).finally(() => setSaving(false));
  }
  return <AdminLayout title="Settings"><PageHead h1="The details that make it yours." sub="Operational settings only — brand design stays locked." />
    <form className="admin-panel settings-form" onSubmit={save}><h2>Announcement bar</h2><div className="form-grid"><label className="form-field full">Top-of-page message<input value={announcement} onChange={e => setAnnouncement(e.target.value)} maxLength={90} required /></label></div>
      <h2>Social & contact</h2><div className="form-grid"><label className="form-field">Instagram URL<input value={instagram} onChange={e => setInstagram(e.target.value)} placeholder="https://www.instagram.com/…" /></label><label className="form-field">Facebook URL<input value={facebook} onChange={e => setFacebook(e.target.value)} placeholder="https://www.facebook.com/..." /></label><label className="form-field">TikTok URL<input value={tiktok} onChange={e => setTiktok(e.target.value)} placeholder="https://www.tiktok.com/..." /></label><label className="form-field">WhatsApp number (digits only)<input value={whatsapp} onChange={e => setWhatsapp(e.target.value)} placeholder="447911123456" />{whatsapp.replace(/\D/g, '')?<span className="fine-print">Active: wa.me/{whatsapp.replace(/\D/g, '')} — checkout & receipt buttons will use it.</span>:<span className="field-error">Required: without it, shoppers see “coming soon” instead of the WhatsApp buttons.</span>}</label></div>
      <h2>Bank transfer details</h2><div className="form-grid"><label className="form-field">Bank name<input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="e.g. Barclays UK" /></label><label className="form-field">Account name<input value={accountName} onChange={e => setAccountName(e.target.value)} /></label><label className="form-field">Account number<input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="12345678" /></label><label className="form-field">IBAN<input value={iban} onChange={e => setIban(e.target.value)} placeholder="GB…" /></label></div>
      <h2>Shipping methods</h2><div className="form-grid"><label className="form-field">Free standard delivery over (£)<input type="number" min={0} value={freeOver} onChange={(e) => setFreeOver(Math.max(0, num(e.target.value)))} /></label><label className="form-field">Low-stock alert at (units)<input type="number" min={1} value={lowAtVal} onChange={(e) => setLowAtVal(Math.max(1, num(e.target.value, 5)))} /></label></div>{shipping.map((m, i) => <div key={m.id} className="colour-row"><label className="form-field">Label<input value={m.label} onChange={(e) => setShipping((s) => s.map((x, n) => n === i ? { ...x, label: e.target.value } : x))} /></label><label className="form-field">Hint<input value={m.hint} onChange={(e) => setShipping((s) => s.map((x, n) => n === i ? { ...x, hint: e.target.value } : x))} /></label><label className="form-field">Price (£)<input type="number" min={0} step={0.01} value={m.price} onChange={(e) => setShipping((s) => s.map((x, n) => n === i ? { ...x, price: Math.max(0, num(e.target.value)) } : x))} /></label><label className="check-line"><input type="checkbox" checked={m.enabled} onChange={(e) => setShipping((s) => s.map((x, n) => n === i ? { ...x, enabled: e.target.checked } : x))} /> On</label><Button variant="tool" type="button" aria-label={`Delete ${m.label}`} onClick={() => setShipping((s) => s.filter((_, n) => n !== i))}><Trash2 size={15} /></Button></div>)}<Button variant="quiet" type="button" onClick={() => { if (shipping.some((m) => m.label === 'New method' && !m.hint && m.price === 0)) { toast.info('Finish the current new row first.'); return; } setShipping((s) => [...s, { id: `ship-${Date.now().toString(36)}`, label: 'New method', hint: '', price: 0, enabled: true }]); }}><Plus size={14} /> ADD METHOD</Button>
      <h2>Backup & restore</h2><p className="fine-print">Download every stored record (products, orders, customers, settings…) as one JSON file, or restore from a backup. Restoring overwrites current data. Backup files contain readable customer data — store them securely.</p><div className="admin-actions"><Button variant="quiet" type="button" onClick={() => {
        const data: Record<string, string | null> = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('huda.')) data[k] = localStorage.getItem(k);
          }
        } catch { /* ignore */ }
        const blob = new Blob([JSON.stringify({ app: 'huda-gymwear', version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `huda-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast.success('Backup downloaded.');
      }}>DOWNLOAD BACKUP</Button><label className="form-field">Restore from file<input type="file" accept="application/json" onChange={(e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result)) as { app?: string; version?: number; data?: Record<string, string | null> };
            if (parsed.app && parsed.app !== 'huda-gymwear') { toast.error('This backup is from another app.'); return; }
            const entries = Object.entries(parsed.data ?? {}).filter(([k]) => k.startsWith('huda.'));
            if (!entries.length) { toast.error('No HUDA records found in this file.'); return; }
            if (!window.confirm(`Restore ${entries.length} record groups? Current data will be overwritten (an auto-backup is kept first).`)) return;
            try {
              const auto: Record<string, string | null> = {};
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('huda.')) auto[k] = localStorage.getItem(k);
              }
              localStorage.setItem('huda.backup.auto', JSON.stringify({ app: 'huda-gymwear', version: 1, exportedAt: new Date().toISOString(), data: auto }));
            } catch { /* auto-backup best effort */ }
            let failed = 0;
            for (const [k, v] of entries) {
              try {
                if (v == null) localStorage.removeItem(k);
                else localStorage.setItem(k, v);
              } catch { failed++; }
            }
            if (failed) { toast.error(`Restore incomplete — ${failed} groups failed (storage full?). Current data kept where writes failed.`); return; }
            toast.success('Backup restored — reloading.');
            setTimeout(() => window.location.reload(), 600);
          } catch { toast.error('Could not read this backup file.'); }
        };
        reader.readAsText(f);
        e.target.value = '';
      }} /></label></div>
      <Button variant="fashion" type="submit" disabled={saving}>{saving ? 'SAVED' : 'SAVE SETTINGS'}</Button></form></AdminLayout>;
}

// --- reviews ----------------------------------------------------------------------
export function AdminReviews() {
  const [tick, setTick] = useState(0);
  const [all, setAll] = useState<Review[]>([]);
  useEffect(() => { allReviews().then(setAll); }, [tick]);
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [q, setQ] = useState('');
  const [replying, setReplying] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  function refresh() { setTick((t) => t + 1); }
  const pending = all.filter((r) => r.status === 'pending').length;
  const shown = all.filter((r) => (tab === 'all' || r.status === tab) && (!q || (r.title + r.body + r.author + (getProduct(r.productId)?.name ?? '')).toLowerCase().includes(q.toLowerCase())));
  return <AdminLayout title="Reviews"><PageHead h1="Reviews" sub={`${pending} awaiting moderation · replies post as HUDA GYMWEAR.`} />
    <div className="admin-filter"><div className="account-tabs">{(['pending', 'approved', 'rejected', 'all'] as const).map((t) => <Button key={t} variant="quiet" className={tab === t ? 'selected' : ''} aria-pressed={tab === t} onClick={() => setTab(t)}>{t[0]?.toUpperCase()}{t.slice(1)}{t === 'pending' && pending > 0 ? ` (${pending})` : ''}</Button>)}</div><label><Search size={16} /><input aria-label="Search reviews" placeholder="Search reviews, products, authors…" value={q} onChange={(e) => setQ(e.target.value)} /></label></div>
    {shown.length === 0 ? <section className="admin-panel"><p className="fine-print">Nothing here. New customer reviews land in Pending.</p></section> : shown.map((r) => {
      const p = getProduct(r.productId);
      return <section className="admin-panel review-row" key={r.id}><div className="review-admin-top">{p && <img src={p.image} alt="" />}{<div><strong>{p?.name ?? r.productId}</strong><p className="fine-print">{r.author} · {r.email}{r.verified ? ' · Verified buyer' : ''} · Size {r.size} · {new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}{r.seed ? ' · Seed' : ''}</p></div>}<span className={`status-tag ${r.status === 'approved' ? 'done' : r.status === 'rejected' ? 'cancelled' : 'pending'}`}>{r.status}</span></div>
        <div className="review-admin-body"><Stars value={r.rating} /><strong>{r.title}</strong><p>{r.body}</p><p className="fine-print">Helpful votes: {r.helpful}</p>
          {r.adminReply && <div className="brand-reply"><strong>Your reply</strong><p>{r.adminReply}</p></div>}
          {replying === r.id ? <form className="url-row" onSubmit={(e) => { e.preventDefault(); if (!replyText.trim()) { toast.info('Write a reply first — or remove it below.'); return; } void replyReview(r.id, replyText).then(() => { setReplying(null); setReplyText(''); refresh(); toast.success('Reply posted.'); }); }}><input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Reply as HUDA GYMWEAR…" aria-label="Brand reply" /><Button variant="quiet" type="submit" disabled={!replyText.trim()}>POST REPLY</Button></form> : null}
          <div className="admin-actions">{r.status !== 'approved' && <Button variant="quiet" size="sm" onClick={() => { void setReviewStatus(r.id, 'approved').then(() => { refresh(); toast.success('Review approved — live on the product page.'); }); }}><Check size={14} /> APPROVE</Button>}{r.status !== 'rejected' && <Button variant="quiet" size="sm" onClick={() => { void setReviewStatus(r.id, 'rejected').then(() => { refresh(); toast.success('Review rejected.'); }); }}><X size={14} /> REJECT</Button>}<Button variant="link" size="sm" aria-expanded={replying === r.id} onClick={() => { if (replying === r.id && replyText.trim() && replyText.trim() !== (r.adminReply ?? '').trim()) { if (!window.confirm('Discard this unsent reply?')) return; } setReplying(replying === r.id ? null : r.id); setReplyText(r.adminReply ?? ''); }}>{replying === r.id ? 'Cancel reply' : r.adminReply ? 'Edit reply' : 'Reply'}</Button>{r.adminReply && <Button variant="link" size="sm" onClick={() => { if (window.confirm('Remove the brand reply from this review?')) { void replyReview(r.id, '').then(() => { refresh(); toast.success('Reply removed.'); }); } }}>Remove reply</Button>}<Button variant="tool" aria-label={`Delete review by ${r.author}`} onClick={() => { if (window.confirm('Delete this review permanently?')) { void deleteReview(r.id).then(() => { refresh(); toast.success('Review deleted.'); }); } }}><Trash2 size={15} /></Button></div></div></section>;
    })}</AdminLayout>;
}

// --- messages ---------------------------------------------------------------------
export function AdminMessages() {
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<'all' | 'contact' | 'newsletter' | 'launch'>('all');
  void tick;
  function refresh() { setTick((t) => t + 1); }
  const all = listMessages();
  const unread = all.filter((m) => !m.read).length;
  const shown = all.filter((m) => filter === 'all' || m.kind === filter);
  const kindLabel = (k: string) => k === 'contact' ? 'Contact' : k === 'newsletter' ? 'Newsletter' : 'Launch list';
  return <AdminLayout title="Messages"><PageHead h1="Messages" sub={`${unread} unread · contact, newsletter and launch signups in one inbox.`} />
    <div className="admin-filter"><div className="account-tabs">{(['all', 'contact', 'newsletter', 'launch'] as const).map((t) => <Button key={t} variant="quiet" className={filter === t ? 'selected' : ''} aria-pressed={filter === t} onClick={() => setFilter(t)}>{t === 'all' ? 'All' : kindLabel(t)}</Button>)}</div></div>
    {shown.length === 0 ? <section className="admin-panel"><p className="fine-print">Inbox zero. New form submissions appear here.</p></section> : shown.map((m) => <section className="admin-panel" key={m.id}><div className="manage-row"><div><strong>{m.name || m.email}</strong><small>{kindLabel(m.kind)} · {m.email} · {new Date(m.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div><span className={`status-tag ${m.read ? 'neutral' : 'pending'}`}>{m.read ? 'Read' : 'New'}</span></div>{m.message && <p className="mt-6">{m.message}</p>}<div className="admin-actions"><Button variant="quiet" size="sm" onClick={() => { markMessageRead(m.id, !m.read); refresh(); toast.success(m.read ? 'Marked as unread.' : 'Marked as read.'); }}>Mark as {m.read ? 'unread' : 'read'}</Button><Button variant="tool" aria-label={`Delete ${m.kind} message from ${m.email}`} onClick={() => { if (window.confirm('Delete this message?')) { deleteMessage(m.id); refresh(); toast.success('Message deleted.'); } }}><Trash2 size={15} /></Button></div></section>)}</AdminLayout>;
}


function CustomerNotes({ email, onChanged }: { email: string; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [rt, setRt] = useState(0);
  useEffect(() => { listUsers().then((ls) => setUser(ls.find((u) => u.email === email) ?? null)); }, [email, rt]);
  if (!user) return null;
  const bump = () => { setRt((t) => t + 1); onChanged(); };
  return <div className="customer-notes"><div className="form-grid"><label className="form-field full">Tags (comma separated)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={(user.tags ?? []).join(', ') || 'VIP, wholesale…'} /></label></div><div className="admin-actions"><Button variant="quiet" size="sm" onClick={() => { if (!tags.trim()) { if ((user.tags ?? []).length && !window.confirm('Remove all tags from this customer?')) return; } void setCustomerTags(email, tags.split(',')).then(() => { setTags(''); bump(); toast.success('Tags saved.'); }); }}>SAVE TAGS</Button></div>{(user.tags ?? []).length > 0 && <p className="fine-print">Tags: {(user.tags ?? []).join(' · ')}</p>}{(user.notes ?? []).length > 0 ? [...(user.notes ?? [])].reverse().map((n, i) => <p key={i} className="note-line">{n.text}<small className="table-small"> · {new Date(n.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</small></p>) : <p className="fine-print">No notes yet.</p>}<form className="url-row" onSubmit={(e) => { e.preventDefault(); if (!note.trim()) return; const dup = (user.notes ?? []).some((n) => n.text === note.trim() && Date.now() - new Date(n.at).getTime() < 10000); if (dup) { toast.info('This note was just added.'); return; } void addCustomerNote(email, note).then(() => { setNote(''); bump(); toast.success('Note added.'); }); }}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an internal note…" aria-label="Customer note" /><Button variant="quiet" type="submit" size="sm" disabled={!note.trim()}>ADD NOTE</Button></form></div>;
}

// --- draft orders (WhatsApp / phone orders booked by staff) ---------------------
export function AdminOrderDraft() {
  const navigate = useNavigate();
  const [customerEmail, setCustomerEmail] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<{ id: string; size: string; qty: number }[]>([]);
  const [addr, setAddr] = useState({ firstName: '', lastName: '', street: '', city: '', postcode: '', country: 'United Kingdom', phone: '' });
  const [pay, setPay] = useState<'cod' | 'bank'>('cod');
  const [error, setError] = useState('');
  const [placing, setPlacing] = useState(false);
  const draftKey = useRef(`draft-${Date.now().toString(36)}`);
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => { listUsers().then(setUsers); }, []);
  const settings = getSettings();
  const results = q.trim() ? products.filter((p) => (p.name + ' ' + p.colour).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];
  function addLine(id: string) {
    const p = getProduct(id);
    if (!p) return;
    const size = sizes.find((s) => sizeStock(p, s) > 0);
    if (!size) { toast.error(`${p.name} is out of stock.`); return; }
    setLines((ls) => {
      const found = ls.find((l) => l.id === id && l.size === size);
      if (found) {
        if (found.qty + 1 > sizeStock(p, size)) { toast.error(`Only ${sizeStock(p, size)} left in ${size}.`); return ls; }
        return ls.map((l) => (l === found ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...ls, { id, size, qty: 1 }];
    });
    setQ('');
  }
  const detailed = lines.map((l) => ({ line: l, p: getProduct(l.id) })).filter((x) => x.p);
  const subtotal = detailed.reduce((n, { line, p }) => n + effectivePrice(p!) * line.qty, 0);
  const shipMethod = settings.shipping.find((m) => m.enabled) ?? DEFAULT_SHIPPING[0]!;
  const shipPrice = subtotal >= (settings.freeOver ?? 100) && shipMethod.id === 'standard' ? 0 : shipMethod.price;
  const total = subtotal + shipPrice;
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (placing) return;
    const email = (customerEmail || guestEmail).trim().toLowerCase();
    const customer = customerEmail ? users.find((u) => u.email === customerEmail)?.name ?? email : guestName.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setError('Enter a valid customer email.'); return; }
    if (!customer) { setError('Enter the customer name.'); return; }
    if (!detailed.length) { setError('Add at least one item.'); return; }
    if (!addr.street.trim() || !addr.city.trim() || !addr.postcode.trim()) { setError('Complete the delivery address.'); return; }
    for (const { line, p } of detailed) {
      if (sizeStock(p!, line.size) < line.qty) { setError(`Only ${sizeStock(p!, line.size)} × ${p!.name} (${line.size}) left.`); return; }
    }
    setError('');
    setPlacing(true);
    void (async () => {
      try {
        const order = await createOrder({
          email, customer,
          address: { firstName: addr.firstName || customer.split(' ')[0]!, lastName: addr.lastName || customer.split(' ').slice(1).join(' ') || '—', street: addr.street, city: addr.city, postcode: addr.postcode, country: addr.country, phone: addr.phone },
          items: detailed.map(({ line, p }) => ({ productId: p!.id, name: p!.name, colour: p!.colour, size: line.size, qty: line.qty, price: effectivePrice(p!), image: p!.image })),
          subtotal, discount: 0, total, payment: pay,
          shipping: { method: shipMethod.label, price: shipPrice },
          clientKey: draftKey.current,
        });
        for (const { line, p } of detailed) {
          const next = { ...p! };
          next.stockBySize = { ...(next.stockBySize ?? {}), [line.size]: Math.max(0, sizeStock(p!, line.size) - line.qty) };
          void upsertProduct(next);
        }
        toast.success(`Draft order ${order.id} created — ${pay === 'bank' ? 'awaiting payment proof' : 'received'}.`);
        navigate({ to: '/admin/orders' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the order. Please try again.');
        setPlacing(false);
      }
    })();
  }
  return <AdminLayout title="New draft order"><PageHead h1="New draft order" sub="Book a WhatsApp or phone order into the same pipeline." />
    <form onSubmit={submit}><div className="admin-chart-layout">
      <section className="admin-panel"><h2>Customer</h2><div className="form-grid"><label className="form-field full">Registered customer<select value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)}><option value="">Walk-in / guest…</option>{users.map((u) => <option key={u.email} value={u.email}>{u.name} — {u.email}</option>)}</select></label>{!customerEmail && <><label className="form-field">Name<input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Customer name" /></label><label className="form-field">Email<input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} placeholder="you@example.co.uk" /></label></>}</div></section>
      <section className="admin-panel"><h2>Delivery address</h2><div className="form-grid"><label className="form-field">First name<input value={addr.firstName} onChange={(e) => setAddr({ ...addr, firstName: e.target.value })} /></label><label className="form-field">Last name<input value={addr.lastName} onChange={(e) => setAddr({ ...addr, lastName: e.target.value })} /></label><label className="form-field full">Street<input value={addr.street} onChange={(e) => setAddr({ ...addr, street: e.target.value })} /></label><label className="form-field">Town / city<input value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></label><label className="form-field">Postcode<input value={addr.postcode} onChange={(e) => setAddr({ ...addr, postcode: e.target.value })} /></label><label className="form-field">Phone<input value={addr.phone} onChange={(e) => setAddr({ ...addr, phone: e.target.value })} /></label></div></section>
    </div><div className="admin-chart-layout">
      <section className="admin-panel"><h2>Items</h2><label className="form-field">Add product<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or colour…" /></label>{results.length > 0 && <div className="pick-grid">{results.map((p) => <button key={p.id} type="button" className="pick-card" aria-label={`Add ${p.name} to draft order`} onClick={() => addLine(p.id)}><img src={p.image} alt="" /><span>{p.name}</span><span>{money(effectivePrice(p))}</span></button>)}</div>}{detailed.length === 0 ? <p className="fine-print">No items yet.</p> : detailed.map(({ line, p }) => <div key={line.id + line.size} className="manage-row"><div><strong>{p!.name}</strong><small>{p!.colour} · {money(effectivePrice(p!))} each</small></div><div className="admin-actions"><select value={line.size} aria-label={`Size for ${p!.name}`} onChange={(e) => { const ns = e.target.value; setLines((ls) => ls.map((l) => l === line ? { ...l, size: ns, qty: Math.min(l.qty, Math.max(1, sizeStock(p!, ns))) } : l)); }}>{sizes.filter((s) => s === line.size || sizeStock(p!, s) > 0).map((s) => <option key={s} value={s}>{s}{sizeStock(p!, s) <= 0 ? ' (0 left)' : ''}</option>)}</select><Button variant="tool" type="button" aria-label={`Decrease quantity of ${p!.name} ${line.size}`} disabled={line.qty <= 1} onClick={() => setLines((ls) => ls.map((l) => (l === line ? { ...l, qty: Math.max(1, l.qty - 1) } : l)))}>−</Button><span>{line.qty}</span><Button variant="tool" type="button" aria-label={`Increase quantity of ${p!.name} ${line.size}`} disabled={line.qty >= sizeStock(p!, line.size)} onClick={() => setLines((ls) => ls.map((l) => { if (l !== line) return l; if (l.qty + 1 > sizeStock(p!, l.size)) { toast.error('No more stock in this size.'); return l; } return { ...l, qty: l.qty + 1 }; }))}>+</Button><Button variant="tool" type="button" aria-label={`Remove ${p!.name} ${line.size} from draft`} onClick={() => setLines((ls) => ls.filter((l) => l !== line))}><Trash2 size={14} /></Button></div></div>)}
        <label className="form-field mt-6">Payment<select value={pay} onChange={(e) => setPay(e.target.value as 'cod' | 'bank')}><option value="cod">Cash on delivery</option><option value="bank">Bank transfer</option></select></label></section>
      <section className="admin-panel"><h2>Summary</h2><div className="bag-total"><span>Subtotal</span><strong>{money(subtotal)}</strong></div><div className="bag-total"><span>Delivery ({shipMethod.label})</span><span>{shipPrice === 0 ? 'FREE' : money(shipPrice)}</span></div><div className="bag-total grand"><span>Total</span><strong>{money(total)}</strong></div>{error && <p className="field-error" role="alert">{error}</p>}<div className="admin-actions end"><Button variant="fashion" type="submit" disabled={placing}>{placing ? 'CREATING…' : 'CREATE ORDER'}</Button></div></section>
    </div></form></AdminLayout>;
}
