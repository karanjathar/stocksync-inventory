import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { dateTime, money } from '../format';
import { Badge, Card, Empty, ErrorBanner, Field, Page, STATUS_TONE } from '../components/ui';
import { subscribeEvents } from '../api/events';
import type { Customer, Order, OrderStatus, PaymentsConfig, Product, Warehouse } from '../api/types';

const CHAT_CHANNELS: readonly string[] = ['whatsapp', 'messenger', 'instagram', 'telegram'];
const METHOD_LABEL = { COD: 'Cash on delivery', ONLINE: 'Online' } as const;
const PAY_LABEL = { UNPAID: 'unpaid', PAID: 'paid', REFUND_DUE: 'Refund due' } as const;
const PAY_TONE = { UNPAID: 'neutral', PAID: 'good', REFUND_DUE: 'bad' } as const;

interface LinkInfo { number: number; url: string; notified: boolean; copied: boolean; sent: boolean }

const FILTERS: (OrderStatus | 'ALL')[] = ['ALL', 'PENDING', 'CONFIRMED', 'FULFILLED', 'CANCELLED'];

export function Orders() {
  const { can } = useAuth();
  const { settings } = useSettings();
  const [filter, setFilter] = useState<OrderStatus | 'ALL'>('ALL');
  const [creating, setCreating] = useState(false);
  const [warehouseFor, setWarehouseFor] = useState<Record<string, string>>({});
  const orders = useApi<Order[]>(filter === 'ALL' ? '/orders' : `/orders?status=${filter}`);
  const warehouses = useApi<Warehouse[]>('/warehouses');
  const payConfig = useApi<PaymentsConfig>('/payments/config');
  const action = useAction();
  const canWrite = can('staff');
  const [linkInfo, setLinkInfo] = useState<LinkInfo | null>(null);
  const { reload } = orders;
  // Live: payments and orders change while this page is open (Razorpay webhooks, chat orders).
  useEffect(() => subscribeEvents((e) => {
    if (e.type === 'payment.updated' || e.type === 'order.created' || e.type === 'order.updated') reload();
  }), [reload]);

  const paymentLink = async (o: Order, notify: boolean) => {
    const res = await action.run(() => api<{ url: string; expiresAt: string; notified: boolean }>(`/orders/${o.id}/payment-link`, { body: { notify } }));
    if (!res) return;
    let copied = false;
    if (!notify) {
      try { await navigator.clipboard.writeText(res.url); copied = true; } catch { /* clipboard blocked: the URL is shown below */ }
    }
    setLinkInfo({ number: o.number, url: res.url, notified: res.notified, copied, sent: notify });
    orders.reload(); // a COD order becomes ONLINE when a link is requested
  };

  const transition = async (o: Order, verb: 'confirm' | 'fulfill' | 'cancel') => {
    if (verb === 'cancel' && !window.confirm(`Cancel order #${o.number}?${o.status === 'CONFIRMED' ? ' Stock will be returned.' : ''}`)) return;
    const wh = warehouseFor[o.id];
    const body = verb === 'confirm' ? (wh ? { warehouseId: wh } : {}) : {};
    const ok = await action.run(() => api(`/orders/${o.id}/${verb}`, { body }));
    if (ok) orders.reload();
  };

  return (
    <Page title="Orders" actions={canWrite && <button className="primary" onClick={() => setCreating(true)}>+ New order</button>}>
      <ErrorBanner error={orders.error ?? action.error} />
      {linkInfo && (
        <div className="banner ok" role="status">
          <strong>Payment link for order #{linkInfo.number}</strong>
          <code className="code-line">{linkInfo.url}</code>
          {linkInfo.sent
            ? (linkInfo.notified ? '✅ Sent to the customer\'s chat.' : '⚠️ This customer can\'t be reached on chat — select and copy the link above to share it.')
            : (linkInfo.copied ? '📋 Copied to the clipboard.' : 'Select and copy the link above to share it.')}
          {' '}<button className="ghost small" onClick={() => setLinkInfo(null)}>Dismiss</button>
        </div>
      )}
      {creating && <NewOrder onDone={() => { setCreating(false); orders.reload(); }} onCancel={() => setCreating(false)} />}
      <div className="row" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'primary small' : 'small'} onClick={() => setFilter(f)}>{f.toLowerCase()}</button>
        ))}
      </div>
      <Card>
        {orders.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
              <tbody>
                {orders.data.map((o) => (
                  <tr key={o.id} className={o.paymentStatus === 'REFUND_DUE' ? 'row-alert' : undefined}>
                    <td><strong>#{o.number}</strong><div className="muted small">{dateTime(o.createdAt)}</div></td>
                    <td>{o.customerName}<div><Badge tone="info">{o.channel}</Badge></div></td>
                    <td>{o.items.map((i) => <div key={i.productId}>{i.quantity} × {i.name}</div>)}{o.notes && <div className="muted small">{o.notes}</div>}</td>
                    <td className="num">{money(o.totalCents, settings.currency)}</td>
                    <td>
                      <Badge tone={STATUS_TONE[o.status]}>{o.status}</Badge>
                      <div className="row" style={{ marginTop: 4 }}>
                        <Badge>{METHOD_LABEL[o.paymentMethod]}</Badge>
                        <Badge tone={PAY_TONE[o.paymentStatus]}>{PAY_LABEL[o.paymentStatus]}</Badge>
                      </div>
                      {o.paymentStatus === 'REFUND_DUE' && <div className="small" style={{ color: 'var(--bad)' }}>Refund the customer in Razorpay</div>}
                    </td>
                    <td>{canWrite && (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {o.status === 'PENDING' && (
                          <>
                            <select aria-label={`Warehouse for #${o.number}`} style={{ width: 'auto' }}
                              value={warehouseFor[o.id] ?? settings.defaultWarehouseId ?? ''}
                              onChange={(e) => setWarehouseFor((m) => ({ ...m, [o.id]: e.target.value }))}>
                              <option value="">Warehouse…</option>
                              {warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
                            </select>
                            <button className="small primary" disabled={action.busy} onClick={() => void transition(o, 'confirm')}>Confirm</button>
                          </>
                        )}
                        {o.status === 'CONFIRMED' && <button className="small primary" disabled={action.busy} onClick={() => void transition(o, 'fulfill')}>Fulfil</button>}
                        {(o.status === 'PENDING' || o.status === 'CONFIRMED') && <button className="small danger" disabled={action.busy} onClick={() => void transition(o, 'cancel')}>Cancel</button>}
                        {payConfig.data?.onlineAvailable && o.paymentStatus === 'UNPAID' && o.status !== 'CANCELLED' && (
                          <>
                            {CHAT_CHANNELS.includes(o.channel) && <button className="small" disabled={action.busy} onClick={() => void paymentLink(o, true)}>Send link</button>}
                            <button className="small" disabled={action.busy} onClick={() => void paymentLink(o, false)}>Copy link</button>
                          </>
                        )}
                      </div>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{orders.loading ? 'Loading…' : 'No orders.'}</Empty>}
      </Card>
    </Page>
  );
}

function NewOrder({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const customers = useApi<Customer[]>('/customers');
  const products = useApi<Product[]>('/products');
  const [customerId, setCustomerId] = useState('');
  const [lines, setLines] = useState<{ productId: string; quantity: string }[]>([{ productId: '', quantity: '1' }]);
  const [notes, setNotes] = useState('');
  const { busy, error, run } = useAction();

  const setLine = (i: number, patch: Partial<{ productId: string; quantity: string }>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const items = lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) }));
    const ok = await run(() => api('/orders', { body: { customerId, items, notes: notes || undefined } }));
    if (ok) onDone();
  };

  return (
    <form className="card grid" onSubmit={submit} aria-label="New order">
      <h2>New order</h2>
      <ErrorBanner error={error} />
      <Field label="Customer">
        <select required value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">Select… (add customers on the Customers page)</option>
          {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}
        </select>
      </Field>
      {lines.map((l, i) => (
        <div className="form-grid" key={i}>
          <Field label={`Item ${i + 1}`}>
            <select value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })}>
              <option value="">Select product…</option>
              {products.data?.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name} ({p.totalQuantity} in stock)</option>)}
            </select>
          </Field>
          <Field label="Qty"><input type="number" min={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></Field>
        </div>
      ))}
      <div><button type="button" className="small" onClick={() => setLines((ls) => [...ls, { productId: '', quantity: '1' }])}>+ Add item</button></div>
      <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>Create order</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
