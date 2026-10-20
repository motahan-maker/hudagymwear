// src/components/printify-admin.tsx — the Printify screen inside Brand Studio
//
// Everything on this page is a thin, honest wrapper over the `printify` Edge
// Function. No token field is ever repopulated, no provider cost is ever used
// as a price, and nothing here claims to be safe because the UI says so:
// the server re-checks the session, the role, the payment gate and the COD
// policy on every single action.
//
// The copy deliberately spells out the money risk. Printify has no sandbox:
// a submitted order charges the merchant payment method, and brand-new stores
// auto-approve orders within 24 hours.

import { useCallback, useEffect, useState } from 'react';
import { Printer, RefreshCw, Check, X, Trash2, Plus, Truck, RotateCcw, ShieldCheck, Download, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { AdminLayout, PageHead } from '@/components/admin';
import { useCategories } from '@/lib/merch';
import { guessTone, money } from '@/lib/catalog';
import { subscribeToStoreEvent } from '@/lib/realtime';
import { toast } from 'sonner';
import {
  deleteWebhook, fulfil, getQueue, getReady, getStatus, importProduct, listWebhooks, printifyReady,
  publishProduct, refreshOrder, registerWebhook, retryFulfilment, saveToken, selectShop, setAutoProduction,
  setCodPolicy, setEnabled, syncProducts, testConnection, variantColours,
  WEBHOOK_TOPICS,
  type Pfy, type ImportInput, type PrintifyPendingProduct, type PrintifyQueueRow, type PrintifyReadyOrder,
  type PrintifyShop, type PrintifyStatus, type PrintifyWebhook,
} from '@/lib/printify';

const STATE_LABEL: Record<string, string> = {
  pending_claim: 'Not sent yet',
  awaiting_payment: 'Waiting for payment',
  not_eligible: 'Not eligible',
  submitting: 'Sending…',
  submitted: 'Sent to Printify',
  partially_fulfilled: 'Partially fulfilled',
  fulfilled: 'Fulfilled',
  failed: 'Failed',
  manual_review: 'Needs a look',
  cancelled: 'Cancelled',
};
const label = (state: string) => STATE_LABEL[state] ?? state;
const isFailure = (state: string) => state === 'failed' || state === 'not_eligible' || state === 'awaiting_payment' || state === 'manual_review';
const isActive = (state: string) => state === 'submitted' || state === 'partially_fulfilled' || state === 'fulfilled';

/** A row is only retryable when nothing is in flight and it never landed. */
function canRetry(row: PrintifyQueueRow): boolean {
  if (row.state === 'submitting') return false;
  return isFailure(row.state);
}

export function AdminPrintify() {
  const [status, setStatus] = useState<PrintifyStatus | null>(null);
  const [shops, setShops] = useState<PrintifyShop[]>([]);
  const [queue, setQueue] = useState<PrintifyQueueRow[]>([]);
  const [ready, setReady] = useState<PrintifyReadyOrder[]>([]);
  const [webhooks, setWebhooks] = useState<PrintifyWebhook[]>([]);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [importing, setImporting] = useState<PrintifyPendingProduct | null>(null);
  const [codOpen, setCodOpen] = useState(false);

  const load = useCallback(async () => {
    if (!printifyReady()) { setLoaded(true); return; }
    // Independent reads go out together — no waterfall behind a spinner.
    const [s, q, r] = await Promise.all([getStatus(), getQueue(), getReady()]);
    if (s.ok) setStatus(s);
    else setProblem(s.error);
    if (q.ok) setQueue(q.queue);
    if (r.ok) setReady(r.ready);
    // Webhooks only make sense once a token and a shop exist; this call reaches
    // Printify, so it stays behind that gate instead of firing on every visit.
    if (s.ok && s.has_token && s.shop_id) {
      const w = await listWebhooks();
      if (w.ok) setWebhooks(w.webhooks);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    // A new receipt changes what is ready to send.
    const off = subscribeToStoreEvent('orders:changed', () => void load());
    return off;
  }, [load]);

  // Every action follows the same shape: block, call, show the refusal in full,
  // reload. No silent failures — the spec asks for visible, recoverable errors.
  // The result is returned so a dialog can read it (e.g. how many variants
  // mapped) without re-fetching or guessing.
  async function run<T extends object>(name: string, fn: () => Promise<Pfy<T>>, onOk?: (res: T) => void, okMsg?: string): Promise<Pfy<T>> {
    if (busy) return { ok: false, error: `${busy} is still running — wait for it to finish.` };
    setBusy(name); setProblem('');
    const res = await fn();
    setBusy('');
    if (!res.ok) {
      setProblem(res.error || 'the request was refused');
      toast.error(res.error || 'Printify request failed');
      return res;
    }
    onOk?.(res);
    if (okMsg) toast.success(okMsg);
    await load();
    return res;
  }

  if (!printifyReady()) {
    return <AdminLayout title="Printify">
      <PageHead h1="Printify" sub="Print-on-demand fulfilment." />
      <section className="admin-panel">
        <div className="admin-panel-title"><h2>Fulfilment is unavailable here</h2></div>
        <p className="fine-print">
          This store is running in local demo mode. Printify is called server-side by the “printify” Edge
          Function, which needs a real Supabase project. Sending a production order charges a payment method,
          so there is deliberately no demo version of it.
        </p>
        <p className="fine-print">Connect Supabase, then open this screen again. The one-time setup, verification
          and rollback steps are written for a human in <code>supabase/PRINTIFY_SETUP.md</code>.</p>
      </section>
    </AdminLayout>;
  }

  const sendable = ready.filter((r) => !r.blocked);

  return <AdminLayout title="Printify">
    <PageHead h1="Printify" sub="Print-on-demand production and tracking. Tokens never reach this browser." >
      <Button variant="tool" aria-label="Refresh Printify status" disabled={!!busy} onClick={() => void load()}><RefreshCw /></Button>
      <Button variant="quiet" disabled={!!busy || !status?.shop_id} onClick={() => void run('Syncing catalogue', syncProducts, undefined, 'Catalogue synced.')}>
        <Download size={14} /> SYNC CATALOGUE
      </Button>
    </PageHead>

    {problem && <p className="field-error" role="alert">{problem}</p>}
    {!loaded && <p className="fine-print">Loading Printify state…</p>}

    <ConnectionPanel
      status={status} shops={shops} busy={busy} tokenDraft={tokenDraft}
      setTokenDraft={setTokenDraft}
      onToken={() => void run('Saving token', () => saveToken(tokenDraft.trim()), () => setTokenDraft(''), 'Token stored server-side.')}
      onTest={() => void run('Testing connection', testConnection, (r) => setShops(r.shops), 'Connected to Printify.')}
      onPickShop={(s) => void run('Selecting shop', () => selectShop(s.id, s.title), undefined, `Shop set to ${s.title}.`)}
      onToggle={(enabled) => void run(enabled ? 'Enabling fulfilment' : 'Turning fulfilment off', () => setEnabled(enabled), undefined, enabled ? 'Fulfilment enabled.' : 'Fulfilment disabled.')}
    />

    {status && <MoneyPanel
      status={status} busy={busy}
      onAuto={(enabled) => void run('Updating production setting', () => setAutoProduction(enabled), undefined, enabled ? 'Orders will be sent to production automatically.' : 'Orders stay in Printify for manual approval.')}
      onOpenCod={() => setCodOpen(true)}
    />}

    {status && <CataloguePanel
      status={status} busy={busy}
      onImport={setImporting}
      onPublish={(externalId) => void run('Publishing product', () => publishProduct(externalId), undefined, 'Product published to Printify.')}
    />}

    {status && <section className="admin-panel">
      <div className="admin-panel-title"><h2>Ready to send</h2><span>{sendable.length} order{sendable.length === 1 ? '' : 's'}</span></div>
      <p className="fine-print">
        Only the lines that resolve through the variant map are sent. Anything else on the order — handmade
        pieces, unmapped colours — stays on the existing order and is fulfilled the way it always was.
      </p>
      {ready.length === 0 && <p className="fine-print">No untried orders contain Printify lines right now.</p>}
      {ready.map((r) => <div className="manage-row" key={r.order_id}>
        <div>
          <strong>{r.order_id} — {r.customer}</strong>
          <small>
            {r.printify_lines} Printify line{r.printify_lines === 1 ? '' : 's'}
            {r.other_lines > 0 ? ` · ${r.other_lines} kept in-house` : ''} · {money(r.total)} · {r.payment === 'cod' ? 'COD' : 'Bank transfer'}
          </small>
          {r.blocked && <small className="field-error">{r.blocked}</small>}
        </div>
        <div className="admin-actions">
          <Button variant="fashion" size="sm" disabled={!!busy || !!r.blocked} onClick={() => void run(`Sending ${r.order_id}`, () => fulfil(r.order_id), undefined, `${r.order_id} sent to Printify.`)}>
            <Truck size={13} /> SEND
          </Button>
        </div>
      </div>)}
    </section>}

    <section className="admin-panel">
      <div className="admin-panel-title"><h2>Fulfilment attempts</h2><span>{queue.length} on record</span></div>
      <p className="fine-print">Fulfilment state is stored separately from the order status, the payment status and the customer timeline. Nothing here rewrites those.</p>
      {queue.length === 0 && <p className="fine-print">Nothing has been claimed yet.</p>}
      {queue.length > 0 && <div className="table-scroll"><table className="admin-table">
        <thead><tr><th scope="col">Order</th><th scope="col">State</th><th scope="col">Printify</th><th scope="col">Tries</th><th scope="col">Last message</th><th scope="col" /></tr></thead>
        <tbody>{queue.map((row) => <tr key={row.order_id}>
          <td data-label="Order">{row.order_id}<small className="table-small">{row.customer} · {money(Number(row.total) || 0)}</small></td>
          <td data-label="State"><span className={`status-tag ${isActive(row.state) ? 'done' : isFailure(row.state) ? 'cancelled' : 'pending'}`}>{label(row.state)}</span></td>
          <td data-label="Printify">{row.printify_order_id || '—'}<small className="table-small">{row.printify_status ? `${row.printify_status} · ${row.meaning}` : ''}</small></td>
          <td data-label="Tries">{row.attempts ?? 0}</td>
          <td data-label="Last message"><small className="table-small">{row.last_error || ''}</small></td>
          <td className="cell-action"><div className="admin-actions">
            {canRetry(row) && <Button variant="quiet" size="sm" disabled={!!busy} onClick={() => void run(`Retrying ${row.order_id}`, () => retryFulfilment(row.order_id), undefined, `${row.order_id} retried.`)}><RotateCcw size={13} /> RETRY</Button>}
            {row.printify_order_id && <Button variant="tool" aria-label={`Re-read ${row.order_id} from Printify`} disabled={!!busy} onClick={() => void run(`Re-reading ${row.order_id}`, () => refreshOrder(row.order_id), (r) => toast.success(`${r.shipments_reconciled} shipment(s) reconciled.`))}><RefreshCw size={14} /></Button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    {status && <WebhookPanel
      webhooks={webhooks} status={status} busy={busy}
      onRegister={(topic) => void run(`Registering ${topic}`, () => registerWebhook(topic), (r) => {
        if (r.signature_expected.startsWith('unconfirmed')) toast.warning('Registered, but Printify did not confirm a signing secret.');
        else toast.success('Webhook registered.');
      })}
      onDelete={(id) => void run('Removing webhook', () => deleteWebhook(id), undefined, 'Webhook removed.')}
    />}

    <Dialog open={!!importing} onOpenChange={() => setImporting(null)}>
      <DialogContent>
        {importing && <ImportForm
          product={importing}
          busy={busy}
          onClose={() => setImporting(null)}
          onDone={(msg) => { setImporting(null); toast.success(msg); void load(); }}
          submit={(input) => run('Creating draft', () => importProduct(input))}
        />}
      </DialogContent>
    </Dialog>

    <Dialog open={codOpen} onOpenChange={() => setCodOpen(false)}>
      <DialogContent>
        <DialogTitle>Cash on delivery through Printify</DialogTitle>
        <DialogDescription>
          Printify is paid by the payment method on your account, not by the customer at the door. Allowing COD
          orders to be produced therefore needs a recorded note explaining how production is funded and how the cash
          is collected. It is an authorisation record — not a claim that Printify collects money.
        </DialogDescription>
        <CodForm
          status={status}
          busy={busy}
          onClose={() => setCodOpen(false)}
          onDone={(msg) => { setCodOpen(false); toast.success(msg); void load(); }}
          submit={(allowed, note) => run(allowed ? 'Recording COD policy' : 'Withdrawing COD policy', () => setCodPolicy(allowed, note))}
        />
      </DialogContent>
    </Dialog>
  </AdminLayout>;
}

// ---------------------------------------------------------------- connection
function ConnectionPanel(props: {
  status: PrintifyStatus | null; shops: PrintifyShop[]; busy: string; tokenDraft: string;
  setTokenDraft: (v: string) => void;
  onToken: () => void; onTest: () => void; onPickShop: (s: PrintifyShop) => void; onToggle: (enabled: boolean) => void;
}) {
    const { status, shops, busy, tokenDraft, setTokenDraft, onToken, onTest, onPickShop, onToggle } = props;
    // The shops discovered by the last successful test. The server remembers
    // them, so the list survives a reload instead of only being visible for
    // the moment after the test button was pressed.
    const visibleShops = shops.length > 0 ? shops : (status?.shops ?? []);
  const enabled = status?.enabled === true;
  return <section className="admin-panel">
    <div className="admin-panel-title"><h2>Connection</h2><span>{status?.token_hint ? `token ${status.token_hint}` : 'no token stored'}</span></div>
    <div className="metric-grid">
      {[
        ['Fulfilment', enabled ? 'ON' : 'OFF', enabled ? 'orders can be claimed and sent' : 'nothing is sent anywhere'],
        ['Shop', status?.shop_title || 'not selected', status?.shop_id ? `id ${status.shop_id}` : 'test the connection to list shops'],
        ['Linked products', String(status?.counts.imported ?? 0), `${status?.counts.pending ?? 0} awaiting review · ${status?.counts.unsupported ?? 0} unsupported`],
        ['Last sync', status?.last_sync_at ? new Date(status.last_sync_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never', status?.last_error ? 'see the error below' : 'catalogue mirror'],
      ].map(([t, v, s]) => <div className="metric" key={t}><span>{t}</span><strong>{v}</strong><small>{s}</small></div>)}
    </div>

    {!enabled && <p className="fine-print">
      While fulfilment is off, no order can be claimed and nothing is sent to Printify. Reading status still works.
    </p>}

    <form className="url-row" onSubmit={(e) => { e.preventDefault(); if (tokenDraft.trim().length >= 20) onToken(); }}>
      <input
        type="password" autoComplete="off" spellCheck={false}
        value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)}
        aria-label="Printify API token" placeholder={status?.token_hint ? 'Replace the stored token…' : 'Paste your Printify Personal Access Token'}
      />
      <Button variant="fashion" type="submit" disabled={!!busy || tokenDraft.trim().length < 20}><ShieldCheck size={14} /> SAVE TOKEN</Button>
    </form>
    <p className="fine-print">
      The token is stored in a table no browser can read and is never returned by the server. Save it, then test the
      connection — a token is only useful once Printify answers. Printify issues it to your account under
      Settings → Printify API; it is a bearer credential, treat it like a password.
    </p>

    <div className="admin-actions">
      <Button variant="quiet" disabled={!!busy || !status?.has_token} onClick={onTest}><RefreshCw size={14} /> TEST CONNECTION</Button>
      <Button variant={enabled ? 'quiet' : 'fashion'} disabled={!!busy} onClick={() => onToggle(!enabled)}>
        {enabled ? <><X size={14} /> TURN OFF FULFILMENT</> : <><Check size={14} /> ENABLE FULFILMENT</>}
      </Button>
    </div>
    {status?.last_test_at && <p className={status.last_test_ok === true ? 'field-ok' : 'field-error'}>
      Last test {new Date(status.last_test_at).toLocaleString('en-GB')} — {status.last_test_ok === true ? 'successful.' : status.last_error || 'failed.'}
    </p>}
    {status?.token_expires_at && (() => {
      const days = Math.floor((new Date(status.token_expires_at).getTime() - Date.now()) / 86_400_000);
      if (days > 45) return null;
      return <p className={days < 0 ? 'field-error' : 'field-error'}>
        {days < 0
          ? 'This Personal Access Token has expired. Fulfilment will fail until a new token is saved.'
          : `This Personal Access Token expires in ${days} day${days === 1 ? '' : 's'}. Printify access tokens are valid for one year — save a replacement before it lapses.`}
      </p>;
    })()}
    {!enabled && status?.last_test_ok === true && !status?.shop_id && <p className="fine-print">Pick a shop below, then enable fulfilment.</p>}

    {visibleShops.length > 1 && <p className="field-warn">
      This token can see {visibleShops.length} shops. Nothing is chosen for you — select the one that holds the HUDA GYMWEAR
      products, because every product, order and webhook belongs to a single shop.
    </p>}

    {visibleShops.length > 0 && <div className="mt-6">{visibleShops.map((s) => <div className="manage-row" key={s.id}>
      <div><strong>{s.title}</strong><small>{s.sales_channel || 'no sales channel'} · id {s.id}</small></div>
      <div className="admin-actions">
        {status?.shop_id === s.id
          ? <span className="status-tag done">SELECTED</span>
          : <Button variant="quiet" size="sm" disabled={!!busy} onClick={() => onPickShop(s)}>USE THIS SHOP</Button>}
      </div>
    </div>)}</div>}
    {visibleShops.length === 0 && status?.has_token && status?.last_test_ok === true &&
      <p className="fine-print">No shop is attached to this token. Create one in Printify under My Stores, then connect it to the API sales channel and test the connection again.</p>}
  </section>;
}

// ---------------------------------------------------------------- money rules
function MoneyPanel({ status, busy, onAuto, onOpenCod }: { status: PrintifyStatus; busy: string; onAuto: (v: boolean) => void; onOpenCod: () => void }) {
  return <section className="admin-panel">
    <div className="admin-panel-title"><h2>Money rules</h2><span>read these before enabling anything</span></div>
    <p className="fine-print">
      Printify has no sandbox. A submitted order is a real purchase from your account, charged to the payment method
      on file, and brand-new Printify stores auto-approve orders within 24 hours. Two settings decide how much of
      that happens without a person in the loop.
    </p>
    <label className="check-line">
      <input type="checkbox" checked={status.auto_send_to_production === true} disabled={!!busy} onChange={(e) => onAuto(e.target.checked)} />
      <span>
        <strong>Send accepted orders to production automatically</strong><br />
        <small className="fine-print">
          Off (default): the order appears in Printify waiting for you to approve it. On: it goes straight to
          production and your payment method is charged.
        </small>
      </span>
    </label>
    <div className="manage-row">
      <div>
        <strong>Cash on delivery</strong>
        <small>{status.cod_fulfilment_allowed
          ? `Allowed — recorded by policy: “${status.cod_policy_note}”${status.cod_policy_at ? ` (${new Date(status.cod_policy_at).toLocaleDateString('en-GB')})` : ''}`
          : 'Blocked. COD stays visible at checkout; those orders simply cannot be claimed for Printify production.'}</small>
      </div>
      <div className="admin-actions">
        <Button variant={status.cod_fulfilment_allowed ? 'quiet' : 'fashion'} size="sm" disabled={!!busy} onClick={onOpenCod}>
          <ShieldCheck size={13} /> {status.cod_fulfilment_allowed ? 'CHANGE POLICY' : 'RECORD A POLICY'}
        </Button>
      </div>
    </div>
    <p className="fine-print">Bank-transfer orders are gated by the existing workflow: nothing can be claimed until the payment has been approved to “Paid”.</p>
  </section>;
}

// ---------------------------------------------------------------- catalogue
function CataloguePanel({ status, busy, onImport, onPublish }: {
  status: PrintifyStatus; busy: string;
  onImport: (p: PrintifyPendingProduct) => void; onPublish: (externalId: string) => void;
}) {
  const rows = status.pending;
  return <section className="admin-panel">
    <div className="admin-panel-title"><h2>Printify catalogue</h2><span>{status.counts.imported} linked · {status.counts.archived} archived</span></div>
    <p className="fine-print">
      Syncing mirrors what your shop holds and never overwrites the storefront fields you own — category, visibility,
      retail price and merchandising stay as you set them. A product that disappears from Printify is archived, not
      deleted, so fulfilment history keeps pointing at something.
    </p>
    {rows.length === 0 && <p className="fine-print">Nothing is waiting for review. Use SYNC CATALOGUE above to pull the shop.</p>}
    {rows.map((p) => { const unsupported = p.unsupported ?? []; return <div className="manage-row" key={p.external_product_id}>
      <div>
        <strong>{p.title}</strong>
        <small>
          {p.status.replace('_', ' ')} · {p.variant_count} variant{p.variant_count === 1 ? '' : 's'} ·
          {/* The production cost is only shown as money when its currency is
              confirmed. Printify does not state the currency on the variant,
              and the catalog's own shipping figures are in USD — presenting an
              unconfirmed number as pounds would be a wrong price, not a
              rounded one. */}
          {p.cost_currency
            ? `production cost ${money(p.cost_pounds)} ${p.cost_currency}`
            : `production cost ${p.cost_cents} minor units (currency not confirmed)`} ·
          {p.product_id ? `linked to ${p.product_id}` : 'no storefront draft'}
        </small>
        {/* Variants the site model cannot represent are listed so a product
            that can never be produced is visible before an order depends on
            it, instead of failing silently at fulfilment time. */}
        {unsupported.length > 0 && <small className="field-error">
          {unsupported.length} variant{unsupported.length === 1 ? '' : 's'} cannot be sold here: {unsupported.slice(0, 3).map((u) => u.reason).join(' · ')}
        </small>}
      </div>
      <div className="admin-actions">
        {!p.product_id && <Button variant="fashion" size="sm" disabled={!!busy} onClick={() => onImport(p)}><Plus size={13} /> CREATE DRAFT</Button>}
        {p.product_id && <Button variant="quiet" size="sm" disabled={!!busy} onClick={() => onPublish(p.external_product_id)}><Printer size={13} /> PUBLISH</Button>}
        {/* Nothing maps, or the provider changed: the colour selection has to be
            revisited. Re-running the form upserts the same draft id, so this
            cannot create a duplicate product. */}
        {p.product_id && (p.status === 'unsupported' || p.status === 'out_of_sync') &&
          <Button variant="quiet" size="sm" disabled={!!busy} onClick={() => onImport(p)}><Pencil size={13} /> RE-LINK</Button>}
      </div>
    </div>; })}
    {rows.length > 0 && <p className="fine-print">
      Showing the {rows.length} most recent. Drafts created here are saved as Draft — invisible to shoppers until you
      activate them on the Products screen.
    </p>}
  </section>;
}

function ImportForm({ product, busy, onClose, onDone, submit }: {
  product: PrintifyPendingProduct; busy: string;
  onClose: () => void; onDone: (msg: string) => void;
  submit: (input: ImportInput) => Promise<Pfy<{ mapped?: number; unsupported?: unknown[] }>>;
}) {
  const categories = useCategories();
  const offered = variantColours(product.variants);
  const [name, setName] = useState(product.title);
  const [category, setCategory] = useState(categories[0]?.name ?? 'Leggings');
  const [price, setPrice] = useState('');
  const [picked, setPicked] = useState<string[]>(offered);
  const priceNum = Number(price);
  const validPrice = Number.isFinite(priceNum) && priceNum > 0;
  // A margin is only meaningful when both numbers are in the same currency.
  // The provider cost's currency is not stated by the API, so no margin is
  // shown until it has been confirmed.
  const currencyConfirmed = product.cost_currency === 'GBP';
  const margin = validPrice && currencyConfirmed ? priceNum - product.cost_pounds : 0;

  return <>
    <DialogTitle>Create a storefront draft</DialogTitle>
    <DialogDescription>{product.title} · production cost {currencyConfirmed ? money(product.cost_pounds) : `${product.cost_cents} minor units (currency not confirmed)`}</DialogDescription>
    <div className="form-grid">
      <label className="form-field">Product name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="form-field">Category
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => <option key={c.name} value={c.name}>{c.name}{c.visible ? '' : ' (hidden)'}</option>)}
        </select>
      </label>
      <label className="form-field">Retail price (£) — you set this
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 52" />
      </label>
      <div className="form-field"><span>Margin at that price</span><strong>{validPrice && currencyConfirmed ? money(margin) : '—'}</strong></div>
    </div>
    <p className="fine-print">
      Printify’s cost is a cost, not a price. It is stored separately and never used as the retail price.
      {!currencyConfirmed && ' The provider cost currency has not been confirmed against the live API, so no margin is shown — the retail price is still entirely yours.'}
    </p>
    {offered.length > 0 && <div className="form-field full">
      <span>Colours to sell through Printify</span>
      <div className="check-options">
        {offered.map((c) => <label key={c}>
          <input type="checkbox" checked={picked.includes(c)} onChange={(e) => setPicked((s) => e.target.checked ? [...s, c] : s.filter((x) => x !== c))} />
          {c}
        </label>)}
      </div>
      <p className="fine-print">Leave a colour unticked to keep it in-house: those variants are not mapped, so such lines are never sent to Printify.</p>
    </div>}
    <div className="editor-foot">
      <Button variant="quiet" onClick={onClose}>CANCEL</Button>
      <Button variant="fashion" disabled={!!busy || !name.trim() || !validPrice || picked.length === 0} onClick={async () => {
        const r = await submit({
          external_product_id: product.external_product_id,
          name: name.trim(), category, retail_price: Math.round(priceNum * 100) / 100,
          tone: guessTone(picked[0] ?? ''),
          colours: picked.map((c) => ({ name: c, tone: guessTone(c) })),
        });
        // A refusal was already surfaced by run(); stay in the dialog so it can be fixed.
        if (!r.ok) return;
        const skipped = Array.isArray(r.unsupported) ? r.unsupported.length : 0;
        onDone(`${name.trim()} saved as Draft — ${r.mapped ?? 0} variant(s) mapped${skipped ? `, ${skipped} combination(s) left unmapped` : ''}.`);
      }}><Plus size={14} /> {product.product_id ? 'SAVE AND RE-LINK' : 'CREATE DRAFT'}</Button>
    </div>
  </>;
}

// ---------------------------------------------------------------- COD dialog
function CodForm({ status, busy, onClose, onDone, submit }: {
  status: PrintifyStatus | null; busy: string; onClose: () => void; onDone: (msg: string) => void;
  submit: (allowed: boolean, note: string) => Promise<Pfy<object>>;
}) {
  const allowed = status?.cod_fulfilment_allowed === true;
  const [note, setNote] = useState(status?.cod_policy_note ?? '');
  return <>
    <div className="form-field full">
      <span>Funding / collection note (at least 20 characters)</span>
      <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Production is funded from the business bank account; COD cash is collected by our own courier and banked weekly." />
      <p className="fine-print">
        Saved against your admin account with a timestamp, so the record shows who authorised it.
        {note.trim().length < 20 && note.length > 0 && <span className="field-error"> {20 - note.trim().length} more characters needed.</span>}
      </p>
    </div>
    <div className="editor-foot">
      <Button variant="quiet" onClick={onClose}>CANCEL</Button>
      {allowed
        ? <Button variant="fashion" disabled={!!busy} onClick={async () => {
          const r = await submit(false, note.trim());
          if (r.ok) onDone('COD fulfilment blocked again.');
        }}>BLOCK COD FULFILMENT</Button>
        : <Button variant="fashion" disabled={!!busy || note.trim().length < 20} onClick={async () => {
          const r = await submit(true, note.trim());
          if (r.ok) onDone('COD fulfilment allowed under the recorded policy.');
        }}><Check size={14} /> ALLOW COD FULFILMENT</Button>}
    </div>
  </>;
}

// ---------------------------------------------------------------- webhooks
function WebhookPanel({ webhooks, status, busy, onRegister, onDelete }: {
  webhooks: PrintifyWebhook[]; status: PrintifyStatus; busy: string;
  onRegister: (topic: string) => void; onDelete: (id: string) => void;
}) {
  const [topic, setTopic] = useState(WEBHOOK_TOPICS[0] ?? 'order:shipment:created');
  // The receiver's own topic list, supplied by the server. The literal in
  // src/lib/printify.ts is only a fallback for before the first status load.
  const topics = status.webhook_topics?.length ? status.webhook_topics : WEBHOOK_TOPICS;
  return <section className="admin-panel">
    <div className="admin-panel-title"><h2>Tracking webhooks</h2><span>{webhooks.length} registered</span></div>
    <p className="fine-print">
      Webhooks are how a shipment becomes a “Shipped” or “Delivered” step on the customer timeline — and only a
      signature-verified delivery may do that. The target is <code>{status.site.webhook_target || 'set SITE_URL on the Edge Function'}</code>.
      Without a registered webhook, tracking can still be reconciled by re-reading an order above.
    </p>
    {webhooks.map((w) => <div className="manage-row" key={w.id}>
      <div><strong>{w.topic}</strong><small>{w.url}</small></div>
      <div className="admin-actions">
        <Button variant="tool" aria-label={`Delete the ${w.topic} webhook`} disabled={!!busy} onClick={() => onDelete(w.id)}><Trash2 size={14} /></Button>
      </div>
    </div>)}
    <form className="url-row mt-6" onSubmit={(e) => { e.preventDefault(); onRegister(topic); }}>
      <select value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Webhook topic">
        {topics.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <Button variant="fashion" type="submit" disabled={!!busy || !status.shop_id}><Plus size={14} /> REGISTER</Button>
    </form>
    {!status.has_webhook_secret && <p className="fine-print">
      A signing secret is generated the first time you register one, stored server-side, and never shown. Until then,
      the receiver refuses every delivery rather than trusting an unsigned one.
    </p>}
    <p className="fine-print">
      Printify does not confirm in its docs that a create request carries the secret back, so after registering,
      watch for one real signed delivery in the event log before treating tracking as trustworthy — the checks are
      listed in <code>supabase/PRINTIFY_SETUP.md</code>.
    </p>
  </section>;
}
