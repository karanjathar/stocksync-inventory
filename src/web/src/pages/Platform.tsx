import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Card, ErrorBanner, Field, Page } from '../components/ui';

interface Row { id: string; slug: string; name: string; status: 'ACTIVE' | 'SUSPENDED' | 'DELETING'; plan: string; subscription: string | null; chatMessages: number; invoices: number; createdAt: string }

/** Operator console. Its own sign-in and token (kept in memory only): a business login never works here, and nothing on this page shows a business's records. */
async function call<T>(token: string | null, path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`/api/platform${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: { message?: string } }).error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

export function Platform() {
  const [token, setToken] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [plans, setPlans] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');

  const load = useCallback(async (tok: string) => {
    try {
      setRows(await call<Row[]>(tok, '/tenants'));
      setPlans((await call<{ code: string; active: boolean }[]>(tok, '/plans')).filter((p) => p.active).map((p) => p.code));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { if (token) void load(token); }, [token, load]);

  const signIn = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    try { setToken((await call<{ token: string }>(null, '/login', { email, password })).token); setPassword(''); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const patch = async (id: string, body: object) => {
    setError(null);
    try { await call(token, `/tenants/${id}`, body, 'PATCH'); await load(token!); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  if (!token) {
    return (
      <div className="login-wrap">
        <form className="card login" onSubmit={signIn} aria-label="Operator sign in">
          <div className="brand big">🛠 Platform console</div>
          <ErrorBanner error={error} />
          <Field label="Email"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <button className="primary" type="submit">Sign in</button>
        </form>
      </div>
    );
  }
  return (
    <Page title="Platform console">
      <ErrorBanner error={error} />
      <Card title={`${rows.length} businesses`}>
        <table>
          <thead><tr><th>Business</th><th>Status</th><th>Plan</th><th>Billing</th><th>Messages (month)</th><th>Invoices (month)</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}<div className="muted small">/shop/{r.slug}</div></td>
                <td><Badge tone={r.status === 'ACTIVE' ? 'good' : 'warn'}>{r.status}</Badge></td>
                <td><select aria-label={`Plan for ${r.name}`} value={r.plan} onChange={(e) => void patch(r.id, { plan: e.target.value })}>{plans.map((p) => <option key={p}>{p}</option>)}</select></td>
                <td>{r.subscription ?? '—'}</td><td>{r.chatMessages}</td><td>{r.invoices}</td>
                <td><button type="button" onClick={() => void patch(r.id, { status: r.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' })}>{r.status === 'ACTIVE' ? 'Suspend' : 'Unsuspend'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
