import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { dateTime, money, toCents } from '../format';
import { Badge, Card, Empty, ErrorBanner, Field, Page } from '../components/ui';
import type { Product, PurchaseOrder, PurchaseStatus, Supplier, Warehouse } from '../api/types';

const FILTERS: (PurchaseStatus | 'ALL')[] = ['ALL', 'DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];
const TONE = { DRAFT: 'neutral', SENT: 'info', PARTIALLY_RECEIVED: 'warn', RECEIVED: 'good', CANCELLED: 'bad' } as const;
const label = (s: string) => s.replace(/_/g, ' ');

type Panel = { kind: 'new' } | { kind: 'edit'; po: PurchaseOrder } | { kind: 'receive'; po: PurchaseOrder } | null;

export function PurchaseOrders() {
  const { can } = useAuth();
  const { settings } = useSettings();
  const canWrite = can('staff');
  const [filter, setFilter] = useState<PurchaseStatus | 'ALL'>('ALL');
  const [panel, setPanel] = useState<Panel>(null);
  const orders = useApi<PurchaseOrder[]>(filter === 'ALL' ? '/purchase-orders' : `/purchase-orders?status=${filter}`);
  const action = useAction();

  const close = () => { setPanel(null); orders.reload(); };
  const act = async (po: PurchaseOrder, verb: 'send' | 'cancel') => {
    if (verb === 'cancel' && !window.confirm(`Cancel purchase order #${po.number}?`)) return;
    const ok = await action.run(() => api(`/purchase-orders/${po.id}/${verb}`, { body: {} }));
    if (ok) orders.reload();
  };

  return (
    <Page title="Purchase orders" actions={canWrite && <button className="primary" onClick={() => setPanel({ kind: 'new' })}>+ New purchase order</button>}>
      <ErrorBanner error={orders.error ?? action.error} />
      {panel?.kind === 'new' && <OrderForm onDone={close} onCancel={() => setPanel(null)} />}
      {panel?.kind === 'edit' && <OrderForm po={panel.po} onDone={close} onCancel={() => setPanel(null)} />}
      {panel?.kind === 'receive' && <ReceiveForm po={panel.po} onDone={close} onCancel={() => setPanel(null)} />}
      <div className="row" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'primary small' : 'small'} onClick={() => setFilter(f)}>{label(f).toLowerCase()}</button>
        ))}
      </div>
      <Card>
        {orders.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Order</th><th>Supplier</th><th>Items</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
              <tbody>
                {orders.data.map((po) => (
                  <tr key={po.id}>
                    <td><strong>#{po.number}</strong><div className="muted small">{dateTime(po.createdAt)}</div></td>
                    <td>{po.supplierName}{po.expectedDate && <div className="muted small">expected {po.expectedDate}</div>}</td>
                    <td>{po.items.map((i) => <div key={i.id}>{i.receivedQuantity}/{i.quantity} × {i.name}</div>)}{po.notes && <div className="muted small">{po.notes}</div>}</td>
                    <td className="num">{money(po.totalCents, settings.currency)}</td>
                    <td><Badge tone={TONE[po.status]}>{label(po.status)}</Badge></td>
                    <td>{canWrite && (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {po.status === 'DRAFT' && <button className="small" disabled={action.busy} onClick={() => setPanel({ kind: 'edit', po })}>Edit</button>}
                        {po.status === 'DRAFT' && <button className="small primary" disabled={action.busy} onClick={() => void act(po, 'send')}>Send</button>}
                        {(po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED') && <button className="small primary" disabled={action.busy} onClick={() => setPanel({ kind: 'receive', po })}>Receive</button>}
                        {(po.status === 'DRAFT' || po.status === 'SENT') && <button className="small danger" disabled={action.busy} onClick={() => void act(po, 'cancel')}>Cancel</button>}
                      </div>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{orders.loading ? 'Loading…' : 'No purchase orders.'}</Empty>}
      </Card>
    </Page>
  );
}

interface Line { productId: string; quantity: string; cost: string }

function OrderForm({ po, onDone, onCancel }: { po?: PurchaseOrder; onDone: () => void; onCancel: () => void }) {
  const suppliers = useApi<Supplier[]>('/suppliers');
  const warehouses = useApi<Warehouse[]>('/warehouses');
  const products = useApi<Product[]>('/products');
  const [supplierId, setSupplierId] = useState(po?.supplierId ?? '');
  const [warehouseId, setWarehouseId] = useState(po?.warehouseId ?? '');
  const [expectedDate, setExpectedDate] = useState(po?.expectedDate ?? '');
  const [notes, setNotes] = useState(po?.notes ?? '');
  const [lines, setLines] = useState<Line[]>(po
    ? po.items.map((i) => ({ productId: i.productId, quantity: String(i.quantity), cost: (i.unitCostCents / 100).toFixed(2) }))
    : [{ productId: '', quantity: '1', cost: '' }]);
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const items: { productId: string; quantity: number; unitCostCents: number }[] = [];
    for (const [i, l] of lines.entries()) {
      if (!l.productId) continue;
      const unitCostCents = toCents(l.cost);
      if (Number.isNaN(unitCostCents)) { setLocalError(`Unit cost for item ${i + 1} must be an amount like 12.50`); return; }
      const quantity = Number(l.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) { setLocalError(`Quantity for item ${i + 1} must be a whole number`); return; }
      items.push({ productId: l.productId, quantity, unitCostCents });
    }
    if (!items.length) { setLocalError('Add at least one item'); return; }
    const ok = po
      ? await run(() => api(`/purchase-orders/${po.id}`, { method: 'PATCH', body: { supplierId, warehouseId, expectedDate: expectedDate || null, notes, items } }))
      : await run(() => api('/purchase-orders', { body: { supplierId, warehouseId, ...(expectedDate ? { expectedDate } : {}), ...(notes ? { notes } : {}), items } }));
    if (ok) onDone();
  };

  return (
    <form className="card grid" onSubmit={submit} aria-label={po ? `Edit purchase order #${po.number}` : 'New purchase order'}>
      <h2>{po ? `Edit purchase order #${po.number}` : 'New purchase order'}</h2>
      <ErrorBanner error={localError ?? error} />
      <div className="form-grid">
        <Field label="Supplier">
          <select required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Select… (add suppliers on the Suppliers page)</option>
            {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Deliver to">
          <select required value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Select…</option>
            {warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
        </Field>
        <Field label="Expected date"><input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></Field>
      </div>
      {lines.map((l, i) => (
        <div className="form-grid" key={i}>
          <Field label={`Item ${i + 1}`}>
            <select value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })}>
              <option value="">Select product…</option>
              {products.data?.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name} ({p.totalQuantity} in stock)</option>)}
            </select>
          </Field>
          <Field label={`Qty ${i + 1}`}><input type="number" min={1} step={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></Field>
          <Field label={`Unit cost ${i + 1}`}><input inputMode="decimal" placeholder="0.00" value={l.cost} onChange={(e) => setLine(i, { cost: e.target.value })} /></Field>
        </div>
      ))}
      <div><button type="button" className="small" onClick={() => setLines((ls) => [...ls, { productId: '', quantity: '1', cost: '' }])}>+ Add item</button></div>
      <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>{po ? 'Save changes' : 'Create purchase order'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ReceiveForm({ po, onDone, onCancel }: { po: PurchaseOrder; onDone: () => void; onCancel: () => void }) {
  const warehouses = useApi<Warehouse[]>('/warehouses');
  const [warehouseId, setWarehouseId] = useState(po.warehouseId);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const remaining = (i: PurchaseOrder['items'][number]) => i.quantity - i.receivedQuantity;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const lines: { itemId: string; quantity: number; warehouseId?: string }[] = [];
    for (const i of po.items) {
      const raw = (qty[i.id] ?? '').trim();
      if (!raw) continue;
      const quantity = Number(raw);
      if (!Number.isInteger(quantity) || quantity < 0) { setLocalError(`Quantity for ${i.sku} must be a whole number`); return; }
      if (quantity === 0) continue;
      if (quantity > remaining(i)) { setLocalError(`Only ${remaining(i)} still expected for ${i.sku}`); return; }
      lines.push({ itemId: i.id, quantity, ...(warehouseId !== po.warehouseId ? { warehouseId } : {}) });
    }
    if (!lines.length) { setLocalError('Enter a quantity to receive'); return; }
    const ok = await run(() => api(`/purchase-orders/${po.id}/receive`, { body: { lines } }));
    if (ok) onDone();
  };

  return (
    <form className="card grid" onSubmit={submit} aria-label={`Receive purchase order #${po.number}`}>
      <h2>Receive goods for #{po.number} — {po.supplierName}</h2>
      <ErrorBanner error={localError ?? error} />
      {po.items.map((i) => (
        <div className="form-grid" key={i.id}>
          <div><strong>{i.name}</strong> <span className="muted">({i.sku})</span><div className="muted small">{remaining(i)} still expected</div></div>
          <Field label={`Receive ${i.sku}`}>
            <input type="number" min={0} step={1} value={qty[i.id] ?? ''} disabled={remaining(i) === 0}
              onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))} />
          </Field>
        </div>
      ))}
      <div className="form-grid">
        <Field label="Receive into">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
        </Field>
      </div>
      <div className="row">
        <button type="button" onClick={() => setQty(Object.fromEntries(po.items.filter((i) => remaining(i) > 0).map((i) => [i.id, String(remaining(i))])))}>Fill remaining</button>
        <button className="primary" type="submit" disabled={busy}>Book receipt</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
