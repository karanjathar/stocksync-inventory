import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { ErrorBanner, Field } from '../components/ui';
import type { Order, SalesReturn, Warehouse } from '../api/types';

const newRequestId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `ret-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Records goods coming back from a customer: quantities are limited to what was bought minus what already came back. */
export function ReturnForm({ order, onDone, onCancel }: { order: Order; onDone: (r: SalesReturn) => void; onCancel: () => void }) {
  const { settings } = useSettings();
  const earlier = useApi<SalesReturn[]>(`/returns?orderId=${order.id}`);
  const warehouses = useApi<Warehouse[]>('/warehouses');
  // One id per opened form: a retry after a network error is recognised by the server and never restocks twice.
  const requestId = useRef(newRequestId());
  const [warehouseId, setWarehouseId] = useState(order.warehouseId ?? settings.defaultWarehouseId ?? '');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const back = new Map<string, number>();
  for (const r of earlier.data ?? []) for (const i of r.items) back.set(i.orderItemId, (back.get(i.orderItemId) ?? 0) + i.quantity);
  const left = (itemId: string, bought: number) => bought - (back.get(itemId) ?? 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!warehouseId) { setLocalError('Choose the warehouse the goods go back to'); return; }
    const lines: { orderItemId: string; quantity: number }[] = [];
    for (const i of order.items) {
      const raw = (qty[i.id] ?? '').trim();
      if (!raw) continue;
      const quantity = Number(raw);
      if (!Number.isInteger(quantity) || quantity < 0) { setLocalError(`Quantity for ${i.sku} must be a whole number`); return; }
      if (quantity === 0) continue;
      if (quantity > left(i.id, i.quantity)) { setLocalError(`Only ${left(i.id, i.quantity)} can still be returned for ${i.sku}`); return; }
      lines.push({ orderItemId: i.id, quantity });
    }
    if (!lines.length) { setLocalError('Enter a quantity to return'); return; }
    const res = await run(() => api<SalesReturn>(`/orders/${order.id}/returns`, {
      body: { requestId: requestId.current, warehouseId, lines, ...(reason.trim() ? { reason: reason.trim() } : {}) },
    }));
    if (res) onDone(res);
  };

  return (
    <form className="card grid" onSubmit={submit} aria-label={`Return for order #${order.number}`}>
      <h2>Return goods — order #{order.number} ({order.customerName})</h2>
      <ErrorBanner error={localError ?? error ?? earlier.error} />
      {order.items.map((i) => (
        <div className="form-grid" key={i.id}>
          <div><strong>{i.name}</strong> <span className="muted">({i.sku})</span><div className="muted small">{left(i.id, i.quantity)} can still be returned</div></div>
          <Field label={`Return ${i.sku}`}>
            <input type="number" min={0} step={1} value={qty[i.id] ?? ''} disabled={left(i.id, i.quantity) <= 0}
              onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))} />
          </Field>
        </div>
      ))}
      <div className="form-grid">
        <Field label="Return to">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Select…</option>
            {warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
        </Field>
        <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong size, damaged…" /></Field>
      </div>
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>Record return</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
