import { useMemo, useState } from 'react';
import { useApi } from '../hooks';
import { useSettings } from '../settings';
import { money } from '../format';
import { Card, Empty, ErrorBanner, Page } from '../components/ui';

interface Day { day: string; orders: number; units: number; revenueCents: number }
interface Sales { range: { from: string; to: string }; days: Day[]; totals: { orders: number; units: number; revenueCents: number }; byChannel: { channel: string; orders: number; revenueCents: number }[] }
interface Best { products: { sku: string; name: string; units: number; revenueCents: number }[] }
interface Dead { days: number; products: { sku: string; name: string; inStock: number; stockValueCents: number; daysSinceSold: number | null }[] }
interface Margins { products: { sku: string; name: string; units: number; revenueCents: number; unitCostCents: number | null; marginCents: number | null; marginPct: number | null }[];
  totals: { revenueCents: number; costCents: number; marginCents: number; marginPct: number | null; unknownCostProducts: number } }
interface Funnel { conversations: number; orders: number; confirmed: number; paid: number; rates: { conversationToOrder: number | null; orderToConfirmed: number | null; confirmedToPaid: number | null } }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 1000) / 10}%`);

/** Bars for revenue per day. The chart is a picture of the table below it: every value is also text, so nothing depends on seeing the colours. */
export function RevenueChart({ days, currency }: { days: Day[]; currency: string }) {
  const max = Math.max(1, ...days.map((d) => d.revenueCents));
  const w = 640; const h = 140; const bar = w / Math.max(1, days.length);
  return (
    <svg role="img" aria-labelledby="rev-title" aria-describedby="rev-desc" viewBox={`0 0 ${w} ${h + 20}`} width="100%" style={{ maxWidth: w }}>
      <title id="rev-title">Revenue per day</title>
      <desc id="rev-desc">{days.length ? `From ${days[0]!.day} to ${days.at(-1)!.day}. Highest day: ${money(max, currency)}. The exact figures are in the table below.` : 'No data'}</desc>
      {days.map((d, i) => {
        const bh = Math.round((d.revenueCents / max) * h);
        return <rect key={d.day} x={i * bar + 1} y={h - bh} width={Math.max(1, bar - 2)} height={bh} fill="currentColor" opacity={0.75}><title>{`${d.day}: ${money(d.revenueCents, currency)}, ${d.orders} orders`}</title></rect>;
      })}
      <line x1="0" y1={h} x2={w} y2={h} stroke="currentColor" opacity={0.4} />
    </svg>
  );
}

export function Analytics() {
  const { settings } = useSettings();
  const cur = settings.currency;
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(iso(new Date(today.getTime() - 29 * 86_400_000)));
  const [to, setTo] = useState(iso(today));
  const [deadDays, setDeadDays] = useState(60);
  const range = `from=${from}&to=${to}`;
  const sales = useApi<Sales>(`/analytics/sales?${range}`);
  const best = useApi<Best>(`/analytics/best-sellers?${range}&limit=10`);
  const margins = useApi<Margins>(`/analytics/margins?${range}&limit=20`);
  const funnel = useApi<Funnel>(`/analytics/funnel?${range}`);
  const dead = useApi<Dead>(`/analytics/dead-stock?days=${deadDays}`);
  const error = sales.error ?? best.error ?? margins.error ?? funnel.error ?? dead.error;

  return (
    <Page title="Analytics">
      <ErrorBanner error={error} />
      <form className="row" aria-label="Date range" onSubmit={(e) => e.preventDefault()}>
        <label>From <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <span className="muted small">Days are UTC; cancelled orders are not counted. At most one year.</span>
      </form>

      <Card title="Sales">
        {sales.data && (<>
          <p><strong>{money(sales.data.totals.revenueCents, cur)}</strong> from {sales.data.totals.orders} orders ({sales.data.totals.units} units)</p>
          <RevenueChart days={sales.data.days} currency={cur} />
          <details><summary>Show the figures per day</summary>
            <table><caption className="sr-only">Revenue per day</caption>
              <thead><tr><th scope="col">Day</th><th scope="col" className="num">Orders</th><th scope="col" className="num">Units</th><th scope="col" className="num">Revenue</th></tr></thead>
              <tbody>{sales.data.days.map((d) => <tr key={d.day}><th scope="row">{d.day}</th><td className="num">{d.orders}</td><td className="num">{d.units}</td><td className="num">{money(d.revenueCents, cur)}</td></tr>)}</tbody></table>
          </details>
          <h3>By channel</h3>
          {sales.data.byChannel.length ? (
            <table><thead><tr><th scope="col">Channel</th><th scope="col" className="num">Orders</th><th scope="col" className="num">Revenue</th></tr></thead>
              <tbody>{sales.data.byChannel.map((c) => <tr key={c.channel}><th scope="row">{c.channel}</th><td className="num">{c.orders}</td><td className="num">{money(c.revenueCents, cur)}</td></tr>)}</tbody></table>
          ) : <Empty>No orders in this period.</Empty>}
        </>)}
      </Card>

      <Card title="Best sellers">
        {best.data && (best.data.products.length ? (
          <table><thead><tr><th scope="col">Product</th><th scope="col" className="num">Units</th><th scope="col" className="num">Revenue</th></tr></thead>
            <tbody>{best.data.products.map((p) => <tr key={p.sku}><th scope="row">{p.name} <span className="muted small">{p.sku}</span></th><td className="num">{p.units}</td><td className="num">{money(p.revenueCents, cur)}</td></tr>)}</tbody></table>
        ) : <Empty>No sales in this period.</Empty>)}
      </Card>

      <Card title="Profit margin">
        {margins.data && (<>
          <p><strong>{pct(margins.data.totals.marginPct === null ? null : margins.data.totals.marginPct / 100)}</strong> margin ({money(margins.data.totals.marginCents, cur)} on {money(margins.data.totals.revenueCents, cur)})
            {margins.data.totals.unknownCostProducts > 0 && <span className="muted"> · {margins.data.totals.unknownCostProducts} {margins.data.totals.unknownCostProducts === 1 ? 'product has' : 'products have'} no purchase cost yet and {margins.data.totals.unknownCostProducts === 1 ? 'is' : 'are'} left out</span>}</p>
          {margins.data.products.length > 0 && (
            <table><thead><tr><th scope="col">Product</th><th scope="col" className="num">Units</th><th scope="col" className="num">Revenue</th><th scope="col" className="num">Cost each</th><th scope="col" className="num">Margin</th></tr></thead>
              <tbody>{margins.data.products.map((p) => (
                <tr key={p.sku}><th scope="row">{p.name}</th><td className="num">{p.units}</td><td className="num">{money(p.revenueCents, cur)}</td>
                  <td className="num">{p.unitCostCents === null ? 'unknown' : money(p.unitCostCents, cur)}</td><td className="num">{p.marginCents === null ? '—' : `${money(p.marginCents, cur)} (${p.marginPct ?? 0}%)`}</td></tr>))}</tbody></table>
          )}
          <p className="muted small">Cost is the price on your latest received purchase order for each product.</p>
        </>)}
      </Card>

      <Card title="From chat to paid">
        {funnel.data && (
          <ol className="funnel">
            <li><strong>{funnel.data.conversations}</strong> people messaged you</li>
            <li><strong>{funnel.data.orders}</strong> orders from chat <span className="muted">({pct(funnel.data.rates.conversationToOrder)} of conversations)</span></li>
            <li><strong>{funnel.data.confirmed}</strong> confirmed or fulfilled <span className="muted">({pct(funnel.data.rates.orderToConfirmed)} of orders)</span></li>
            <li><strong>{funnel.data.paid}</strong> paid online <span className="muted">({pct(funnel.data.rates.confirmedToPaid)} of confirmed)</span></li>
          </ol>
        )}
      </Card>

      <Card title="Dead stock">
        <label>Not sold for <select value={deadDays} onChange={(e) => setDeadDays(Number(e.target.value))}>{[30, 60, 90, 180].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
        {dead.data && (dead.data.products.length ? (
          <table><thead><tr><th scope="col">Product</th><th scope="col" className="num">In stock</th><th scope="col" className="num">Value</th><th scope="col" className="num">Last sold</th></tr></thead>
            <tbody>{dead.data.products.map((p) => <tr key={p.sku}><th scope="row">{p.name} <span className="muted small">{p.sku}</span></th><td className="num">{p.inStock}</td><td className="num">{money(p.stockValueCents, cur)}</td>
              <td className="num">{p.daysSinceSold === null ? 'never' : `${p.daysSinceSold} days ago`}</td></tr>)}</tbody></table>
        ) : <Empty>Nothing has been sitting for that long.</Empty>)}
      </Card>
    </Page>
  );
}
