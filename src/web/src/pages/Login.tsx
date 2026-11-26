import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { ErrorBanner, Field } from '../components/ui';
import { LanguageSwitch, useT } from '../i18n';

export function Login() {
  const { user, login } = useAuth();
  const { t } = useT();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit} aria-label={t('login.title')}>
        <div className="brand big">📦 StockSync</div>
        <LanguageSwitch />
        <p className="muted">{t('login.intro')}</p>
        <ErrorBanner error={error} />
        <Field label={t('login.email')}>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('login.password')}>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button className="primary" type="submit" disabled={busy}>{busy ? t('login.busy') : t('login.submit')}</button>
        <Link className="muted small" to="/signup">{t('login.newHere')}</Link>
        <a className="muted small" href="/shop">{t('login.visitShop')}</a>
      </form>
    </div>
  );
}
