import { Link } from 'react-router';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { Badge, Card, ErrorBanner } from '../components/ui';

interface Step { id: 'profile' | 'warehouse' | 'product' | 'whatsapp' | 'gst'; done: boolean; optional: boolean }
interface State { steps: Step[]; dismissed: boolean; demo: boolean; complete: boolean }

const COPY: Record<Step['id'], { title: string; hint: string; to: string }> = {
  profile: { title: 'Name your business', hint: 'Business name, currency and contact number.', to: '/settings' },
  warehouse: { title: 'Add a warehouse', hint: 'Where your stock is kept.', to: '/warehouses' },
  product: { title: 'Add your first product', hint: 'A name, a price and how many you have.', to: '/products' },
  whatsapp: { title: 'Connect WhatsApp', hint: 'Let customers order by chat.', to: '/settings' },
  gst: { title: 'Set up GST invoices', hint: 'Needed only if you issue tax invoices.', to: '/settings' },
};

/** First-run checklist for administrators, with one-click sample data. Hidden once finished or dismissed, and silent if it cannot load. */
export function OnboardingCard() {
  const { can } = useAuth();
  const state = useApi<State>(can('admin') ? '/onboarding' : null);
  const act = useAction();
  const s = state.data;
  if (!s) return null;
  const reload = () => state.reload();
  const dismiss = (dismissed: boolean) => act.run(async () => { await api('/onboarding/dismiss', { body: { dismissed } }); reload(); });
  if (s.dismissed) return <button type="button" className="muted small" onClick={() => void dismiss(false)}>Show setup guide</button>;
  if (s.complete && !s.demo) return null;
  const done = s.steps.filter((x) => x.done).length;
  return (
    <Card title={`Get started — ${done} of ${s.steps.length} done`}>
      <ErrorBanner error={act.error} />
      <ul className="checklist">
        {s.steps.map((step) => (
          <li key={step.id}>
            <span aria-hidden="true">{step.done ? '✅' : '⬜'}</span>{' '}
            {step.done ? <span>{COPY[step.id].title}</span> : <Link to={COPY[step.id].to}>{COPY[step.id].title}</Link>}{' '}
            {step.optional && <Badge>optional</Badge>}
            {!step.done && <span className="muted small"> — {COPY[step.id].hint}</span>}
          </li>
        ))}
      </ul>
      <div className="row">
        {s.demo
          ? <button type="button" disabled={act.busy} onClick={() => void act.run(async () => { await api('/onboarding/demo', { method: 'DELETE' }); reload(); })}>Remove sample data</button>
          : <button type="button" disabled={act.busy} onClick={() => void act.run(async () => { await api('/onboarding/demo', { method: 'POST' }); reload(); })}>Add sample data to explore</button>}
        <button type="button" className="muted" onClick={() => void dismiss(true)}>Hide this guide</button>
      </div>
      {s.demo && <p className="muted small">Sample items start with “[Demo]”. Remove them any time; your own data is never touched.</p>}
    </Card>
  );
}
