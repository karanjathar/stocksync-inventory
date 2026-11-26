import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, errorText } from '../api/client';
import { ErrorBanner, Field } from '../components/ui';
import { LanguageSwitch, useT } from '../i18n';

/** Suggests a web address from the business name (lowercase letters, digits, single hyphens). */
export const slugFrom = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function Signup() {
  const { t } = useT();
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
          <h2>{t('signup.checkEmail')}</h2>
          <p>{t('signup.sentTo', { email: sentTo })}</p>
          <ErrorBanner error={error} />
          <button type="button" onClick={resend} disabled={resent}>{resent ? t('signup.resent') : t('signup.resend')}</button>
          <Link className="muted small" to="/login">{t('signup.backToSignIn')}</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit} aria-label={t('signup.title')}>
        <div className="brand big">📦 StockSync</div>
        <LanguageSwitch />
        <p className="muted">{t('signup.intro')}</p>
        <ErrorBanner error={error} />
        <Field label={t('signup.businessName')}><input required minLength={2} maxLength={120} value={form.businessName} onChange={(e) => set('businessName', e.target.value)} /></Field>
        <Field label={t('signup.webAddress')}>
          <input required minLength={3} maxLength={40} pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]" value={form.slug} onChange={(e) => { setSlugEdited(true); set('slug', e.target.value.toLowerCase()); }} aria-describedby="slug-hint" />
        </Field>
        <p id="slug-hint" className="muted small">{t('signup.shopWillLive', { slug: form.slug || 'your-name' })}</p>
        <Field label={t('signup.yourName')}><input required autoComplete="name" maxLength={120} value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></Field>
        <Field label={t('login.email')}><input type="email" required autoComplete="username" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label={t('signup.password')}><input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} /></Field>
        <p className="muted small">{t('signup.passwordHint')}</p>
        <button className="primary" type="submit" disabled={busy}>{busy ? t('signup.busy') : t('signup.submit')}</button>
        <Link className="muted small" to="/login">{t('signup.haveAccount')}</Link>
      </form>
    </div>
  );
}

/** Landing page of the emailed link: confirms the address, which creates the business. */
export function VerifyEmail() {
  const { t } = useT();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'done'; slug: string } | { kind: 'failed'; message: string }>({ kind: 'working' });
  const started = useRef(false); // the link is single use: never send it twice (React strict mode runs effects twice in development)
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) { setState({ kind: 'failed', message: t('verify.incomplete') }); return; }
    api<{ slug: string }>('/signup/verify', { body: { token } }).then((r) => setState({ kind: 'done', slug: r.slug }), (err: unknown) => setState({ kind: 'failed', message: errorText(err) }));
  }, [token]);
  return (
    <div className="login-wrap">
      <div className="card login" role="status">
        <div className="brand big">📦 StockSync</div>
        {state.kind === 'working' && <p>{t('verify.working')}</p>}
        {state.kind === 'done' && (<><h2>{t('verify.done')}</h2><p>{t('verify.ready', { slug: state.slug })}</p><Link className="primary" to="/login">{t('verify.signIn')}</Link></>)}
        {state.kind === 'failed' && (<><h2>{t('verify.failed')}</h2><p>{state.message}</p><Link to="/signup">{t('verify.startAgain')}</Link></>)}
      </div>
    </div>
  );
}
