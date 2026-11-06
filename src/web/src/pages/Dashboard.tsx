import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../hooks';
import { useSettings } from '../settings';
import { money, dateTime } from '../format';
import { subscribeEvents, type StreamStatus } from '../api/events';
import { Badge, Card, Empty, ErrorBanner, Page, STATUS_TONE } from '../components/ui';
import type { DashboardStats, Order, Product, RealtimeEvent } from '../api/types';

interface FeedItem { at: string; text: string; tone: 'neutral' | 'good' | 'warn' | 'info' }

function describe(e: RealtimeEvent): FeedItem {
  const at = new Date().toISOString();
  switch (e.type) {
    case 'stock.changed': return { at, tone: 'neutral', text: `${e.sku}: ${e.quantity} in warehouse · ${e.totalQuantity} total` };
    case 'stock.low': return { at, tone: 'warn', text: `Low stock — ${e.name} (${e.sku}) at ${e.totalQuantity}, reorder level ${e.reorderLevel}` };
    case 'order.created': return { at, tone: 'info', text: `New order #${e.number}` };
    case 'order.updated': return { at, tone: 'good', text: `Order #${e.number} → ${e.status}` };
    case 'message.received': return { at, tone: 'info', text: `${e.channel} message from ${e.from}: “${e.text.slice(0, 80)}”` };
    case 'payment.updated': return { at, tone: e.paymentStatus === 'REFUND_DUE' ? 'warn' : 'good', text: `Order #${e.number} payment → ${e.paymentStatus}` };
  }
}

export function Dashboard() {
  const { settings } = useSettings();
  const stats = useApi<DashboardStats>('/dashboard');
  const low = useApi<Product[]>('/products?lowStock=true');
  const pending = useApi<Order[]>('/orders?status=PENDING');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const { reload: reloadStats } = stats;
  const { reload: reloadLow } = low;
  const { reload: reloadPending } = pending;

  useEffect(() => subscribeEvents((e) => {
    setFeed((f) => [describe(e), ...f].slice(0, 50));
    // Live refresh of the numbers this event affects.
    reloadStats();
    if (e.type.startsWith('stock')) reloadLow();
    if (e.type.startsWith('order')) reloadPending();
  }, setStatus), [reloadStats, reloadLow, reloadPending]);

  const s = stats.data;
  const kpis: { label: string; value: string; alert?: boolean }[] = s ? [
    { label: 'Active products', value: String(s.productCount) },
    { label: 'Units in stock', value: s.totalUnits.toLocaleString() },
    { label: 'Stock value', value: money(s.stockValueCents, settings.currency) },
    { label: 'Low stock', value: String(s.lowStockCount), alert: s.lowStockCount > 0 },
    { label: 'Pending orders', value: String(s.pendingOrders), alert: s.pendingOrders > 0 },
    { label: 'Orders today', value: String(s.ordersToday) },
  ] : [];

  return (
    <Page title="Dashboard" actions={<span className="small muted"><span className={`live-dot ${status}`} />{status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}</span>}>
      <ErrorBanner error={stats.error} />
      <div className="kpis">
        {kpis.map((k) => (
          <div key={k.label} className={`card kpi ${k.alert ? 'alert' : ''}`}>
            <div className="label">{k.label}</div>
            <div className="value">{k.value}</div>
          </div>
        ))}
      </div>
      <div className="grid two">
        <Card title="Needs reordering">
          {low.data?.length ? (
            <table>
              <thead><tr><th>Product</th><th className="num">In stock</th><th className="num">Reorder at</th></tr></thead>
              <tbody>
                {low.data.map((p) => (
                  <tr key={p.id}><td><Link to={`/inventory?productId=${p.id}`}>{p.name}</Link> <span className="muted small">{p.sku}</span></td>
                    <td className="num">{p.totalQuantity} {p.unit}</td><td className="num">{p.reorderLevel}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>All products are above their reorder level 🎉</Empty>}
        </Card>
        <Card title="Pending orders">
          {pending.data?.length ? (
            <table>
              <thead><tr><th>Order</th><th>Customer</th><th>Channel</th><th className="num">Total</th></tr></thead>
              <tbody>
                {pending.data.slice(0, 8).map((o) => (
                  <tr key={o.id}><td><Link to="/orders">#{o.number}</Link><div className="muted small">{dateTime(o.createdAt)}</div></td>
                    <td>{o.customerName}</td><td><Badge tone={STATUS_TONE[o.status]}>{o.channel}</Badge></td>
                    <td className="num">{money(o.totalCents, settings.currency)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No pending orders.</Empty>}
        </Card>
      </div>
      <Card title="Live activity">
        {feed.length ? (
          <ul className="feed">
            {feed.map((f, i) => (
              <li key={`${f.at}-${i}`}><time>{new Date(f.at).toLocaleTimeString()}</time><Badge tone={f.tone}>{f.tone === 'warn' ? 'alert' : 'event'}</Badge><span>{f.text}</span></li>
            ))}
          </ul>
        ) : <Empty>Waiting for activity… stock changes, orders and chat messages appear here instantly.</Empty>}
      </Card>
    </Page>
  );
}
