import { Link } from 'react-router';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import type { PurchaseOrder } from '../api/types';
import { Card, ErrorBanner } from './ui';
import { useState } from 'react';

interface Suggestion { productId: string; sku: string; name: string; unit: string; totalQuantity: number; reorderLevel: number; suggestedQuantity: number; supplierName: string | null }

/** Low-stock products with how much to order and from whom; staff turn them into draft purchase orders in one click. */
export function ReorderCard() {
  const { can } = useAuth();
  const list = useApi<{ suggestions: Suggestion[] }>('/reorder-suggestions');
  const action = useAction();
  const [result, setResult] = useState<{ created: number; unassigned: number } | null>(null);
  const items = list.data?.suggestions ?? [];
  if (!items.length && !result) return null;

  const create = async () => {
    const res = await action.run(() => api<{ created: PurchaseOrder[]; unassigned: Suggestion[] }>('/reorder-suggestions/create-pos', { body: {} }));
    if (res) { setResult({ created: res.created.length, unassigned: res.unassigned.length }); list.reload(); }
  };

  return (
    <Card title="Reorder suggestions">
      <ErrorBanner error={action.error} />
      {result && (
        <div className="banner ok" role="status">
          {result.created ? `Created ${result.created} draft purchase order${result.created === 1 ? '' : 's'}. ` : 'No new purchase orders were needed. '}
          <Link to="/purchase-orders">Review them</Link>
          {result.unassigned ? ` · ${result.unassigned} product${result.unassigned === 1 ? ' has' : 's have'} no usual supplier yet — add them to a purchase order by hand.` : ''}
        </div>
      )}
      {items.length > 0 && (
        <table>
          <thead><tr><th>Product</th><th className="num">In stock</th><th className="num">Order</th><th>Usual supplier</th></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.productId}>
                <td>{s.name} <span className="muted small">{s.sku}</span></td>
                <td className="num">{s.totalQuantity} {s.unit}</td>
                <td className="num">{s.suggestedQuantity}</td>
                <td>{s.supplierName ?? <span className="muted">none yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {can('staff') && items.length > 0 && <div style={{ marginTop: 8 }}><button className="primary" disabled={action.busy} onClick={create}>Create purchase orders</button></div>}
    </Card>
  );
}
