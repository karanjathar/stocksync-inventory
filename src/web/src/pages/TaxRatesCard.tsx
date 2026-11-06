import { useState } from 'react';
import { api } from '../api/client';
import { useAction, useApi } from '../hooks';
import { parsePercentBp } from '../format';
import { Badge, Card, Field } from '../components/ui';
import type { TaxRate } from '../api/types';

const pct = (bp: number): string => `${bp % 100 === 0 ? bp / 100 : (bp / 100).toFixed(2)}%`;

/**
 * Named tax rates (e.g. GST 18%). Editing happens by adding a new rate and switching products to it: the rate in force is copied onto
 * every order line, so past orders and invoices never change. Kept outside the settings form so its Enter key cannot submit it.
 */
export function TaxRatesCard() {
  const rates = useApi<TaxRate[]>('/tax-rates');
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const add = async () => {
    setFormError(null);
    const rateBp = parsePercentBp(rate);
    if (Number.isNaN(rateBp)) { setFormError('Rate must be a percentage from 0 to 100 with at most 2 decimals, e.g. 18 or 12.5'); return; }
    if (!name.trim()) { setFormError('Give the tax rate a name, e.g. GST 18%'); return; }
    const ok = await run(() => api<TaxRate>('/tax-rates', { body: { name: name.trim(), rateBp } }));
    if (ok) { setName(''); setRate(''); rates.reload(); }
  };
  const toggle = async (r: TaxRate) => {
    const ok = await run(() => api<TaxRate>(`/tax-rates/${r.id}`, { method: 'PATCH', body: { active: !r.active } }));
    if (ok) rates.reload();
  };
  const problem = formError ?? error;

  return (
    <Card title="Tax rates">
      <p className="small muted">Assign a rate to each product on the product form. Deactivating a rate hides it from new products; existing orders keep the rate they were sold at.</p>
      {rates.error && <p className="small muted">Tax rates could not be loaded ({rates.error}).</p>}
      {rates.data?.length ? (
        <table>
          <tbody>
            {rates.data.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="num"><span>{pct(r.rateBp)}</span></td>
                <td>{r.active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}</td>
                <td><button type="button" className="small" disabled={busy} aria-label={`${r.active ? 'Deactivate' : 'Activate'} ${r.name}`} onClick={() => void toggle(r)}>{r.active ? 'Deactivate' : 'Activate'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted small">{rates.loading ? 'Loading…' : 'No tax rates yet.'}</p>}
      <div className="form-grid">
        <Field label="Tax rate name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="GST 18%" /></Field>
        <Field label="Rate (%)"><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="18" /></Field>
        <div><button type="button" className="primary" disabled={busy} onClick={() => void add()}>Add tax rate</button></div>
      </div>
      {problem && <p className="small" style={{ color: 'var(--bad)' }}>{problem}</p>}
    </Card>
  );
}
