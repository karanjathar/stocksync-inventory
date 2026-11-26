import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { dateTime, money, toCents } from '../format';
import { Badge, Card, Empty, ErrorBanner, Field, Page } from '../components/ui';
import type { Product, PurchaseOrder, PurchaseOrderStatus, Supplier, Warehouse } from '../api/types';

const TONE: Record<PurchaseOrderStatus, 'neutral' | 'info' | 'warn' | 'good' | 'bad'> = {
  DRAFT: 'neutral', SENT: 'info', PARTIALLY_RECEIVED: 'warn', RECEIVED: 'good', CANCELLED: 'bad',
};
interface LineDraft { productId: string; quantity: string; cost: string }

export function PurchaseOrders() {
  const { can } = useAuth();
  const { settings } = useSettings();
  const canWrite = can('staff');
  const orders = useApi<PurchaseOrder[]>('/purchase-orders');
  const suppliers = useApi<Supplier[]>('/suppliers');
  const warehouses = useApi<Warehouse[]>('/warehouses');
  const products = useApi<Product[]>('/products');
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<{ po: PurchaseOrder; receiptId: string; qty: Record<string, string> } | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitCostCents: toCents(l.cost) }));
    if (!supplierId || !warehouseId) return setFormError('Choose a supplier and a warehouse.');
    if (!parsed.length || parsed.some((l) => !l.productId || !Number.isInteger(l.quantity) || l.quantity < 1 || Number.isNaN(l.unitCostCents))) {
      return setFormError('Each line needs a product, a whole quantity of at least 1 and a unit cost like 9.50.');
    }
    if (new Set(parsed.map((l) => l.productId)).size !== parsed.length) return setFormError('Each product can appear once.');
    const ok = await action.run(() => api('/purchase-orders', { body: { supplierId, warehouseId, notes, lines: parsed } }));
    if (ok) { setCreating(false); setLines([]); setNotes(''); orders.reload(); }
  };

  const post = async (po: PurchaseOrder, path: string) => { if (await action.run(() => api(`/purchase-orders/${po.id}/${path}`, { method: 'POST', body: {} }))) orders.reload(); };

  const startReceive = (po: PurchaseOrder) => setReceiving({
    po, receiptId: crypto.randomUUID(), // one id per form, so a double click cannot receive twice
    qty: Object.fromEntries(po.lines.map((l) => [l.productId, String(l.quantity - l.receivedQuantity)])),
  });
  const confirmReceive = async () => {
    if (!receiving) return;
    const picked = receiving.po.lines.map((l) => ({ productId: l.productId, quantity: Number(receiving.qty[l.productId]) })).filter((l) => l.quantity > 0);
    if (!picked.length) return;
    const ok = await action.run(() => api(`/purchase-orders/${receiving.po.id}/receive`, { body: { receiptId: receiving.receiptId, lines: picked } }));
    if (ok) { setReceiving(null); orders.reload(); }
  };

  return (
    <Page title="Purchase orders" actions={canWrite && <button className="primary" onClick={() => setCreating((v) => !v)}>New purchase order</button>}>
      <ErrorBanner error={orders.error ?? action.error ?? formError} />
      {creating && canWrite && (
        <Card title="New purchase order">
          <form className="grid" onSubmit={save} aria-label="New purchase order">
            <div className="form-grid">
              <Field label="Supplier">
                <select aria-label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">— choose —</option>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Deliver to">
                <select aria-label="Warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">— choose —</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
                </select>
              </Field>
            </div>
            {lines.map((l, i) => (
              <div className="form-grid" key={i}>
                <Field label="Product">
                  <select aria-label={`Line ${i + 1} product`} value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })}>
                    <option value="">— choose —</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
                  </select>
                </Field>
                <Field label="Quantity"><input aria-label={`Line ${i + 1} quantity`} inputMode="numeric" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></Field>
                <Field label="Unit cost" hint={settings.currency}><input aria-label={`Line ${i + 1} unit cost`} inputMode="decimal" value={l.cost} onChange={(e) => setLine(i, { cost: e.target.value })} /></Field>
                <div><button type="button" className="small danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button></div>
              </div>
            ))}
            <div><button type="button" className="small" onClick={() => setLines((ls) => [...ls, { productId: '', quantity: '1', cost: '0' }])}>+ Add line</button></div>
            <Field label="Notes"><input aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
            <div><button className="primary" type="submit" disabled={action.busy}>Save draft</button></div>
          </form>
        </Card>
      )}
      {receiving && canWrite && (
        <Card title={`Receive goods for #${receiving.po.number}`}>
          {receiving.po.lines.filter((l) => l.quantity > l.receivedQuantity).map((l) => (
            <div className="row" key={l.productId} style={{ marginBottom: 6 }}>
              <span style={{ minWidth: 220 }}>{l.sku} — {l.name} <span className="muted small">({l.quantity - l.receivedQuantity} still expected)</span></span>
              <input type="number" min={0} max={l.quantity - l.receivedQuantity} aria-label={`Receive ${l.sku}`} style={{ width: 90 }}
                value={receiving.qty[l.productId] ?? ''} onChange={(e) => setReceiving({ ...receiving, qty: { ...receiving.qty, [l.productId]: e.target.value } })} />
            </div>
          ))}
          <div className="row">
            <button className="primary" disabled={action.busy} onClick={confirmReceive}>Confirm receipt</button>
            <button onClick={() => setReceiving(null)}>Close</button>
          </div>
        </Card>
      )}
      <Card>
        {orders.data?.length ? (
          <table>
            <thead><tr><th>PO</th><th>Supplier</th><th>Status</th><th>Items</th><th className="num">Total</th><th>Created</th>{canWrite && <th><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>
              {orders.data.map((p) => (
                <tr key={p.id}>
                  <td>#{p.number}</td><td>{p.supplierName}</td>
                  <td><Badge tone={TONE[p.status]}>{p.status}</Badge></td>
                  <td>{p.lines.map((l) => `${l.receivedQuantity}/${l.quantity} ${l.sku}`).join(', ')}</td>
                  <td className="num">{money(p.totalCents, settings.currency)}</td>
                  <td className="small muted">{dateTime(p.createdAt)}</td>
                  {canWrite && (
                    <td className="row">
                      {p.status === 'DRAFT' && <button className="small primary" disabled={action.busy} onClick={() => post(p, 'send')}>Send</button>}
                      {(p.status === 'SENT' || p.status === 'PARTIALLY_RECEIVED') && <button className="small primary" onClick={() => startReceive(p)}>Receive</button>}
                      {(p.status === 'DRAFT' || p.status === 'SENT') && <button className="small danger" disabled={action.busy}
                        onClick={() => { if (window.confirm(`Cancel purchase order #${p.number}?`)) void post(p, 'cancel'); }}>Cancel</button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>{orders.loading ? 'Loading…' : 'No purchase orders yet. Low-stock products can be turned into orders from the Dashboard.'}</Empty>}
      </Card>
    </Page>
  );
}
