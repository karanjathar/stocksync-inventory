import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { Scanner } from '../components/Scanner';
import { useAction } from '../hooks';
import { ErrorBanner, Field } from '../components/ui';
import type { Product, Warehouse } from '../api/types';

type Op = 'receive' | 'issue' | 'adjust' | 'transfer';
const OPS: { op: Op; label: string; button: string }[] = [
  { op: 'receive', label: 'Receive', button: 'Receive stock' },
  { op: 'issue', label: 'Issue', button: 'Issue stock' },
  { op: 'adjust', label: 'Adjust', button: 'Set stock count' },
  { op: 'transfer', label: 'Transfer', button: 'Transfer stock' },
];

interface Props {
  products: Pick<Product, 'id' | 'sku' | 'name'>[];
  warehouses: Warehouse[];
  initialProductId?: string;
  onDone: () => void;
}

export function StockOperation({ products, warehouses, initialProductId = '', onDone }: Props) {
  const [op, setOp] = useState<Op>('receive');
  const [productId, setProductId] = useState(initialProductId);
  const [warehouseId, setWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const [scanError, setScanError] = useState<string | null>(null);
  const current = OPS.find((o) => o.op === op)!;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    const qty = Number(quantity);
    const body =
      op === 'transfer' ? { productId, fromWarehouseId: warehouseId, toWarehouseId, quantity: qty, reason } :
      op === 'adjust' ? { productId, warehouseId, newQuantity: qty, reason } :
      { productId, warehouseId, quantity: qty, reason };
    const ok = await run(() => api(`/stock/${op}`, { body }));
    if (ok !== undefined) {
      setDone(`${current.label} recorded.`);
      setQuantity('');
      onDone();
    }
  };

  const onScan = async (raw: string) => {
    const code = raw.trim().toUpperCase();
    setScanError(null);
    try {
      const p = await api<{ id: string }>(`/products/by-barcode/${encodeURIComponent(code)}`);
      if (products.some((x) => x.id === p.id)) setProductId(p.id); else setScanError(`Product with barcode ${code} is not in this list.`);
    } catch (e) {
      setScanError(e instanceof ApiError && e.status === 404 ? `No product has barcode ${code}.` : 'Could not look up that barcode.');
    }
  };

  const whSelect = (label: string, value: string, set: (v: string) => void) => (
    <Field label={label}>
      <select required value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Select…</option>
        {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
      </select>
    </Field>
  );

  return (
    <form className="card grid" onSubmit={submit} aria-label="Stock operation">
      <div className="row" role="tablist">
        {OPS.map((o) => (
          <button key={o.op} type="button" role="tab" aria-selected={op === o.op} className={op === o.op ? 'primary small' : 'small'} onClick={() => setOp(o.op)}>{o.label}</button>
        ))}
      </div>
      <ErrorBanner error={error ?? scanError} />
      <Scanner onScan={(code) => void onScan(code)} label="Scan product barcode" />
      {done && <div className="banner ok">{done}</div>}
      <div className="form-grid">
        <Field label="Product">
          <select required value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Select…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
          </select>
        </Field>
        {op === 'transfer' ? (
          <>
            {whSelect('From warehouse', warehouseId, setWarehouseId)}
            {whSelect('To warehouse', toWarehouseId, setToWarehouseId)}
          </>
        ) : whSelect('Warehouse', warehouseId, setWarehouseId)}
        <Field label={op === 'adjust' ? 'New count' : 'Quantity'}>
          <input aria-label="Quantity" required type="number" min={op === 'adjust' ? 0 : 1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label={op === 'adjust' ? 'Reason' : 'Reason / reference'}>
          <input required={op === 'adjust'} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={op === 'adjust' ? 'cycle count, damage…' : 'PO number, note…'} />
        </Field>
      </div>
      <div><button className="primary" type="submit" disabled={busy}>{current.button}</button></div>
    </form>
  );
}
