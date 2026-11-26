import { useApi } from '../hooks';
import { money } from '../format';
import { Badge, Card, ErrorBanner, Page } from '../components/ui';

interface Plan { code: string; name: string; priceMinor: number; currency: string; maxProducts: number | null; maxUsers: number | null; maxChatMessages: number | null; maxInvoices: number | null }
interface UsageResponse { plan: Plan; period: string; usage: { products: number; users: number; chatMessages: number; invoices: number } }

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  const tone = limit !== null && used >= limit ? 'bad' : pct >= 80 ? 'warn' : 'good';
  return (
    <div className="meter">
      <div className="row"><strong>{label}</strong><span>{used} of {limit === null ? 'unlimited' : limit}</span> {limit !== null && used >= limit && <Badge tone="bad">limit reached</Badge>}</div>
      {limit !== null && <progress aria-label={`${label} used`} value={pct} max={100} data-tone={tone} />}
    </div>
  );
}

/** What this business has used of its plan. Limits only stop new records: nothing already saved is ever removed. */
export function Usage() {
  const { data, error } = useApi<UsageResponse>('/usage');
  return (
    <Page title="Plan & usage">
      <ErrorBanner error={error} />
      {data && (
        <Card title={`${data.plan.name} plan${data.plan.priceMinor ? ` — ${money(data.plan.priceMinor, data.plan.currency)} / month` : ''}`}>
          <Meter label="Products" used={data.usage.products} limit={data.plan.maxProducts} />
          <Meter label="Users" used={data.usage.users} limit={data.plan.maxUsers} />
          <Meter label={`Chat messages (${data.period})`} used={data.usage.chatMessages} limit={data.plan.maxChatMessages} />
          <Meter label={`Invoices (${data.period})`} used={data.usage.invoices} limit={data.plan.maxInvoices} />
          <p className="muted small">When a limit is reached you can still see and use everything you have; only adding more is paused until you upgrade or the month rolls over.</p>
        </Card>
      )}
    </Page>
  );
}
