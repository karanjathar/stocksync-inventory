import { api } from '../api/client';
import { useAction, useApi } from '../hooks';
import { money, dateTime } from '../format';
import { Badge, Card, ErrorBanner } from '../components/ui';

interface Sub { status: 'CREATED' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED'; planCode: string; pendingPlanCode: string | null; trialEndsAt: string | null;
  currentPeriodEnd: string | null; graceEndsAt: string | null; cancelAtPeriodEnd: boolean; shortUrl: string | null }
interface State { configured: boolean; plan: { code: string; name: string }; subscription: Sub | null; trialDays: number; trialAvailable: boolean;
  offers: { code: string; name: string; priceMinor: number; currency: string }[] }

/** Plan and subscription for the business. Payment happens on Razorpay's page; the plan here changes only after Razorpay confirms. */
export function Billing() {
  const state = useApi<State>('/billing');
  const act = useAction();
  const s = state.data;
  if (!s) return null; // quiet while loading or when the server cannot answer: Settings stays usable
  const sub = s.subscription;
  const live = sub !== null && ['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(sub.status);
  const subscribe = (plan: string) => act.run(async () => {
    const r = await api<{ shortUrl: string }>('/billing/subscribe', { body: { plan } });
    window.location.assign(r.shortUrl);
  });
  const post = (path: string, body?: unknown) => act.run(async () => { await api(path, { method: 'POST', body: body ?? {} }); state.reload(); });

  return (
    <Card title={`Billing — ${s.plan.name} plan`}>
      <ErrorBanner error={act.error} />
      {!s.configured && <p className="muted">Online billing is not set up on this server yet.</p>}
      {sub?.status === 'TRIAL' && sub.trialEndsAt && <p><Badge tone="info">Trial</Badge> Free trial until {dateTime(sub.trialEndsAt)}. Your card is charged after that.</p>}
      {sub?.status === 'PAST_DUE' && <p role="alert"><Badge tone="warn">Payment failed</Badge> Please update your payment method on Razorpay{sub.graceEndsAt ? ` before ${dateTime(sub.graceEndsAt)}` : ''}; after that your account moves to Free (your data is kept).</p>}
      {sub?.status === 'ACTIVE' && <p><Badge tone="good">Active</Badge> {sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {sub.currentPeriodEnd ? dateTime(sub.currentPeriodEnd) : ''}{sub.pendingPlanCode ? ` · switching to ${sub.pendingPlanCode} next cycle` : ''}</p>}
      {sub?.status === 'CREATED' && sub.shortUrl && <p><Badge>Not finished</Badge> <a href={sub.shortUrl}>Complete payment setup on Razorpay</a></p>}
      {sub && ['EXPIRED', 'CANCELLED'].includes(sub.status) && <p className="muted">Your last subscription has ended. You are on the Free plan; nothing you saved was removed.</p>}
      {s.configured && (
        <div className="row">
          {s.offers.map((o) => {
            const label = `${o.name} — ${money(o.priceMinor, o.currency)}/month`;
            if (!live) return <button key={o.code} type="button" disabled={act.busy} onClick={() => void subscribe(o.code)}>{s.trialAvailable ? `Start ${s.trialDays}-day trial: ${label}` : `Subscribe: ${label}`}</button>;
            if (o.code === sub.planCode || o.code === sub.pendingPlanCode) return null;
            return <button key={o.code} type="button" disabled={act.busy} onClick={() => void post('/billing/change', { plan: o.code })}>Switch to {label}</button>;
          })}
          {live && !sub.cancelAtPeriodEnd && <button type="button" className="danger" disabled={act.busy} onClick={() => { if (window.confirm('Cancel at the end of the current period?')) void post('/billing/cancel'); }}>Cancel subscription</button>}
        </div>
      )}
    </Card>
  );
}
