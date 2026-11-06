import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { money } from '../format';
import { Card, Empty, ErrorBanner, Page } from '../components/ui';
import type { PurchaseOrder } from '../api/types';

interface Suggestion {
  productId: string; sku: string; name: string; unit: string; onHand: number; incoming: number; reorderLevel: number;
  suggestedQuantity: number; supplierId: string | null; supplierName: string | null; lastCostCents: number; costKnown: boolean;
}
interface Result { orders: Pick<PurchaseOrder, 'id' | 'number' | 'supplierName' | 'totalCents'>[]; skipped: { productId: string; reason: string }[] }

export function Reorder() {
  const { can } = useAuth();
  const { settings } = useSettings();
  const canWrite = can('staff');
  const list = useApi<Suggestion[]>('/reorder-suggestions');
  // Everything that can be ordered (has a preferred supplier) starts selected; the user only records what they switch off.
  const [off, setOff] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const action = useAction();

  const selected = new Set((list.data ?? []).filter((s) => s.supplierId && !off.has(s.productId)).map((s) => s.productId));
  const toggle = (id: string) => setOff((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const create = async () => {
    const res = await action.run(() => api<Result>('/reorder-suggestions', { body: { productIds: [...selected] } }));
    if (res) { setResult(res); list.reload(); }
  };
  const nameOf = (id: string) => list.data?.find((s) => s.productId === id)?.sku;

  return (
    <Page title="Reorder suggestions" actions={canWrite && (
      <button className="primary" disabled={action.busy || selected.size === 0} onClick={() => void create()}>Create draft purchase orders</button>
    )}>
      <ErrorBanner error={list.error ?? action.error} />
      {result && (
        <div className="banner ok" role="status">
          <strong>Created {result.orders.length} draft purchase order{result.orders.length === 1 ? '' : 's'}</strong>
          <ul>
            {result.orders.map((o) => <li key={o.id}><Link to="/purchase-orders">#{o.number} · {o.supplierName}</Link> — {money(o.totalCents, settings.currency)}</li>)}
          </ul>
          {result.skipped.length > 0 && (
            <ul>{result.skipped.map((s) => <li key={s.productId}>{nameOf(s.productId) ?? 'Skipped'}: {s.reason}</li>)}</ul>
          )}
          <button className="ghost small" onClick={() => setResult(null)}>Dismiss</button>
        </div>
      )}
      {list.data?.some((s) => !s.costKnown && selected.has(s.productId)) && (
        <div className="banner" role="note">Some selected items have no known cost, so their draft lines are created at a cost of 0.00. Set the real cost on the draft before sending it.</div>
      )}
      <Card>
        {list.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr>{canWrite && <th />}<th>Product</th><th className="num">On hand</th><th className="num">On order</th><th className="num">Reorder level</th><th className="num">Suggested qty</th><th>Supplier</th></tr></thead>
              <tbody>
                {list.data.map((s) => (
                  <tr key={s.productId}>
                    {canWrite && (
                      <td><input type="checkbox" aria-label={`Select ${s.sku}`} checked={selected.has(s.productId)} disabled={!s.supplierId} onChange={() => toggle(s.productId)} /></td>
                    )}
                    <td><strong>{s.name}</strong><div className="muted small">{s.sku}</div></td>
                    <td className="num">{s.onHand}</td>
                    <td className="num">{s.incoming}</td>
                    <td className="num">{s.reorderLevel}</td>
                    <td className="num">{s.suggestedQuantity}{!s.costKnown && <div className="small" style={{ color: 'var(--warn)' }}>cost unknown</div>}</td>
                    <td>{s.supplierName ?? <span className="muted">No preferred supplier</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{list.loading ? 'Loading…' : 'Nothing needs reordering right now.'}</Empty>}
      </Card>
    </Page>
  );
}
