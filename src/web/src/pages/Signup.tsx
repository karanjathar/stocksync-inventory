import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, errorText } from '../api/client';
import { ErrorBanner, Field } from '../components/ui';

/** Suggests a web address from the business name (lowercase letters, digits, single hyphens). */
export const slugFrom = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function Signup() {
  const [form, setForm] = useState({ businessName: '', slug: '', ownerName: '', email: '', password: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v, ...(k === 'businessName' && !slugEdited ? { slug: slugFrom(v) } : {}) }));

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api('/signup', { body: form }); setSentTo(form.email); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const resend = async () => {
    setError(null);
    try { await api('/signup/resend', { body: { email: form.email } }); setResent(true); } catch (err) { setError(errorText(err)); }
  };

  if (sentTo) {
    return (
      <div className="login-wrap">
        <div className="card login" role="status">
          <div className="brand big">📦 StockSync</div>
          <h2>Check your email</h2>
          <p>If the details are valid, we sent a confirmation link to <strong>{sentTo}</strong>. It works once and expires in 24 hours.</p>
          <ErrorBanner error={error} />
          <button type="button" onClick={resend} disabled={resent}>{resent ? 'Sent again (if allowed)' : 'Send the link again'}</button>
          <Link className="muted small" to="/login">Back to sign in</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit} aria-label="Create your account">
        <div className="brand big">📦 StockSync</div>
        <p className="muted">Create your business account. Free to start.</p>
        <ErrorBanner error={error} />
        <Field label="Business name"><input required minLength={2} maxLength={120} value={form.businessName} onChange={(e) => set('businessName', e.target.value)} /></Field>
        <Field label="Web address">
          <input required minLength={3} maxLength={40} pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]" value={form.slug} onChange={(e) => { setSlugEdited(true); set('slug', e.target.value.toLowerCase()); }} aria-describedby="slug-hint" />
        </Field>
        <p id="slug-hint" className="muted small">Your shop will live at /shop/{form.slug || 'your-name'}</p>
        <Field label="Your name"><input required autoComplete="name" maxLength={120} value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></Field>
        <Field label="Email"><input type="email" required autoComplete="username" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Password"><input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} /></Field>
        <p className="muted small">At least 10 characters.</p>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <Link className="muted small" to="/login">Already have an account? Sign in</Link>
      </form>
    </div>
  );
}

/** Landing page of the emailed link: confirms the address, which creates the business. */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'done'; slug: string } | { kind: 'failed'; message: string }>({ kind: 'working' });
  const started = useRef(false); // the link is single use: never send it twice (React strict mode runs effects twice in development)
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) { setState({ kind: 'failed', message: 'This link is incomplete.' }); return; }
    api<{ slug: string }>('/signup/verify', { body: { token } }).then((r) => setState({ kind: 'done', slug: r.slug }), (err: unknown) => setState({ kind: 'failed', message: errorText(err) }));
  }, [token]);
  return (
    <div className="login-wrap">
      <div className="card login" role="status">
        <div className="brand big">📦 StockSync</div>
        {state.kind === 'working' && <p>Confirming your email…</p>}
        {state.kind === 'done' && (<><h2>You're all set</h2><p>Your business is ready at <strong>/shop/{state.slug}</strong>.</p><Link className="primary" to="/login">Sign in</Link></>)}
        {state.kind === 'failed' && (<><h2>We couldn't confirm that link</h2><p>{state.message}</p><Link to="/signup">Start again</Link></>)}
      </div>
    </div>
  );
}
