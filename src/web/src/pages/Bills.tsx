import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { money, toCents } from '../format';
import { Badge, Card, Empty, ErrorBanner, Field, Page } from '../components/ui';
import type { Bill, BillStatus, Payables, PurchaseOrder, Supplier } from '../api/types';

const FILTERS: (BillStatus | 'ALL')[] = ['ALL', 'UNPAID', 'PARTIAL', 'PAID', 'VOID'];
const TONE = { UNPAID: 'warn', PARTIAL: 'info', PAID: 'good', VOID: 'bad' } as const;
const METHODS = ['bank', 'cash', 'upi', 'cheque'] as const;

const newRequestId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function Bills() {
  const { can } = useAuth();
  const { settings } = useSettings();
  const canWrite = can('staff');
  const [filter, setFilter] = useState<BillStatus | 'ALL'>('ALL');
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<Bill | null>(null);
  const bills = useApi<Bill[]>(filter === 'ALL' ? '/bills' : `/bills?status=${filter}`);
  const payables = useApi<Payables>(canWrite ? '/reports/payables' : null);
  const action = useAction();
  const reloadAll = () => { bills.reload(); payables.reload(); };

  const voidBill = async (b: Bill) => {
    if (!window.confirm(`Void bill #${b.number}? This cannot be undone.`)) return;
    const ok = await action.run(() => api(`/bills/${b.id}/void`, { body: {} }));
    if (ok) reloadAll();
  };

  return (
    <Page title="Bills" actions={canWrite && <button className="primary" onClick={() => setCreating(true)}>+ New bill</button>}>
      <ErrorBanner error={bills.error ?? action.error} />
      {canWrite && payables.data && (
        <Card title="Owed to suppliers">
          <p>
            <strong>{money(payables.data.totalOpenCents, settings.currency)}</strong> open
            {payables.data.totalOverdueCents > 0 && <> · <span style={{ color: 'var(--bad)' }}>{money(payables.data.totalOverdueCents, settings.currency)} overdue</span></>}
          </p>
          {payables.data.suppliers.length ? (
            <table>
              <tbody>
                {payables.data.suppliers.map((s) => (
                  <tr key={s.supplierId}>
                    <td>{s.supplierName}</td>
                    <td className="num">{money(s.openCents, settings.currency)}</td>
                    <td className="num">{s.overdueCents > 0 ? <span style={{ color: 'var(--bad)' }}>{money(s.overdueCents, settings.currency)} overdue</span> : <span className="muted">none overdue</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>You owe nothing right now.</Empty>}
        </Card>
      )}
      {creating && <NewBill onDone={() => { setCreating(false); reloadAll(); }} onCancel={() => setCreating(false)} />}
      {paying && <PayForm bill={paying} onDone={() => { setPaying(null); reloadAll(); }} onCancel={() => setPaying(null)} />}
      <div className="row" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'primary small' : 'small'} onClick={() => setFilter(f)}>{f.toLowerCase()}</button>
        ))}
      </div>
      <Card>
        {bills.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Bill</th><th>Supplier</th><th>Due</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
              <tbody>
                {bills.data.map((b) => (
                  <tr key={b.id}>
                    <td><strong>#{b.number}</strong></td>
                    <td>{b.supplierName}</td>
                    <td>{b.dueDate}</td>
                    <td className="num">{money(b.totalCents, settings.currency)}<div className="muted small">{money(b.totalCents - b.paidCents - b.debitCents, settings.currency)} due</div></td>
                    <td><Badge tone={TONE[b.status]}>{b.status}</Badge></td>
                    <td>{canWrite && (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {(b.status === 'UNPAID' || b.status === 'PARTIAL') && <button className="small primary" disabled={action.busy} onClick={() => setPaying(b)}>Pay</button>}
                        {b.status === 'UNPAID' && b.paidCents === 0 && <button className="small danger" disabled={action.busy} onClick={() => void voidBill(b)}>Void</button>}
                      </div>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{bills.loading ? 'Loading…' : 'No bills.'}</Empty>}
      </Card>
    </Page>
  );
}

function PayForm({ bill, onDone, onCancel }: { bill: Bill; onDone: () => void; onCancel: () => void }) {
  const { settings } = useSettings();
  // One id per opened form: a retry after a network error is recognised by the server and never pays twice.
  const requestId = useRef(newRequestId());
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('bank');
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const owed = bill.totalCents - bill.paidCents;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const amountCents = toCents(amount);
    if (Number.isNaN(amountCents) || amountCents <= 0) { setLocalError('Enter an amount like 12.50'); return; }
    if (amountCents > owed) { setLocalError(`That is more than the ${money(owed, settings.currency)} still owed`); return; }
    const ok = await run(() => api(`/bills/${bill.id}/payments`, { body: { requestId: requestId.current, amountCents, method } }));
    if (ok) onDone();
  };

  return (
    <form className="card grid" onSubmit={submit} aria-label={`Pay bill #${bill.number}`}>
      <h2>Pay bill #{bill.number} — {bill.supplierName}</h2>
      <p className="muted">{money(owed, settings.currency)} still owed</p>
      <ErrorBanner error={localError ?? error} />
      <div className="form-grid">
        <Field label="Amount"><input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Method">
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      </div>
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>Record payment</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function NewBill({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const orders = useApi<PurchaseOrder[]>('/purchase-orders');
  const suppliers = useApi<Supplier[]>('/suppliers');
  const [standalone, setStandalone] = useState(false);
  const [purchaseOrderId, setPurchaseOrderId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const { settings } = useSettings();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    let body: Record<string, unknown>;
    if (standalone) {
      const amountCents = toCents(amount);
      if (Number.isNaN(amountCents) || amountCents <= 0) { setLocalError('Enter an amount like 12.50'); return; }
      body = { supplierId, amountCents };
    } else {
      body = { purchaseOrderId };
    }
    if (dueDate) body.dueDate = dueDate;
    const ok = await run(() => api('/bills', { body }));
    if (ok) onDone();
  };

  return (
    <form className="card grid" onSubmit={submit} aria-label="New bill">
      <h2>New bill</h2>
      <ErrorBanner error={localError ?? error} />
      <label className="row"><input type="checkbox" checked={standalone} onChange={(e) => setStandalone(e.target.checked)} aria-label="Not linked to a purchase order" /> Not linked to a purchase order</label>
      <div className="form-grid">
        {standalone ? (
          <>
            <Field label="Supplier">
              <select required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Select…</option>
                {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Amount"><input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          </>
        ) : (
          <Field label="Purchase order" hint="Bills the received goods that are not billed yet">
            <select required value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)}>
              <option value="">Select…</option>
              {orders.data?.filter((o) => o.status === 'PARTIALLY_RECEIVED' || o.status === 'RECEIVED' || o.status === 'CLOSED')
                .map((o) => <option key={o.id} value={o.id}>#{o.number} · {o.supplierName} · {money(o.totalCents, settings.currency)}</option>)}
            </select>
          </Field>
        )}
        <Field label="Due date" hint="Defaults to 30 days"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      </div>
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>Create bill</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
