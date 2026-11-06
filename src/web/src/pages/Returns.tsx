import { useState } from 'react';
import { api } from '../api/client';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { openDocument } from '../documents';
import { dateTime, money } from '../format';
import { Badge, Card, Empty, ErrorBanner, Page } from '../components/ui';
import type { RefundStatus, SalesReturn } from '../api/types';

const TONE = { NOT_REQUIRED: 'neutral', REFUND_DUE: 'bad', REFUNDED: 'good' } as const;
const LABEL = { NOT_REQUIRED: '—', REFUND_DUE: 'refund due', REFUNDED: 'refunded' } as const;

/** Sales returns and their credit notes. Returns are created from the Orders page; refunds are cleared here after paying in Razorpay. */
export function Returns() {
  const { settings } = useSettings();
  const [filter, setFilter] = useState<RefundStatus | 'ALL'>('ALL');
  const list = useApi<SalesReturn[]>(filter === 'ALL' ? '/returns' : `/returns?refundStatus=${filter}`);
  const action = useAction();

  const markRefunded = async (r: SalesReturn) => {
    if (!window.confirm(`Have you already refunded ${money(r.refundCents, settings.currency)} to the customer for order #${r.orderNumber} in the Razorpay dashboard?\n\nThis clears the flag and tells the customer the refund was issued.`)) return;
    const ok = await action.run(() => api(`/returns/${r.id}/refunded`, { body: {} }));
    if (ok) list.reload();
  };

  return (
    <Page title="Returns">
      <ErrorBanner error={list.error ?? action.error} />
      <div className="row" role="tablist">
        {(['ALL', 'REFUND_DUE'] as const).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'primary small' : 'small'} onClick={() => setFilter(f)}>{f === 'ALL' ? 'all' : 'refund due'}</button>
        ))}
      </div>
      <Card>
        {list.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Return</th><th>Order</th><th>Items</th><th className="num">Credit</th><th>Credit note</th><th>Refund</th><th /></tr></thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id} className={r.refundStatus === 'REFUND_DUE' ? 'row-alert' : undefined}>
                    <td><strong>#{r.number}</strong><div className="muted small">{dateTime(r.createdAt)}</div></td>
                    <td>Order #{r.orderNumber}{r.reason && <div className="muted small">{r.reason}</div>}</td>
                    <td>{r.items.map((i) => <div key={i.orderItemId}>{i.quantity} × {i.name}</div>)}</td>
                    <td className="num">{money(r.creditTotalCents, settings.currency)}{r.creditTaxCents > 0 && <div className="muted small">tax {money(r.creditTaxCents, settings.currency)}</div>}</td>
                    <td><span>{r.creditNote.number}</span></td>
                    <td><Badge tone={TONE[r.refundStatus]}>{LABEL[r.refundStatus]}</Badge></td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="small" disabled={action.busy} onClick={() => void action.run(() => openDocument(`/credit-notes/${r.creditNote.id}/print`))}>Credit note</button>
                        {r.refundStatus === 'REFUND_DUE' && <button className="small primary" disabled={action.busy} onClick={() => void markRefunded(r)}>Mark refunded</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{list.loading ? 'Loading…' : 'No returns.'}</Empty>}
      </Card>
    </Page>
  );
}
