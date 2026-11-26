import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction } from '../hooks';
import { ErrorBanner, Field, Page } from '../components/ui';

export function Account() {
  const { user } = useAuth();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (newPassword !== confirm) { setError('New passwords do not match'); return; }
    const ok = await run(() => api('/auth/password', { body: { currentPassword, newPassword } }).then(() => true));
    if (ok) { setDone(true); setCurrent(''); setNew(''); setConfirm(''); }
  };

  return (
    <Page title="My account">
      <form className="card grid" onSubmit={submit} aria-label="Change password" style={{ maxWidth: 480 }}>
        <p className="muted">{user?.name} · {user?.email} · {user?.role}</p>
        <h2>Change password</h2>
        <ErrorBanner error={error} />
        {done && <div className="banner ok" role="status">Password changed.</div>}
        <Field label="Current password"><input type="password" required autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="At least 8 characters"><input type="password" required minLength={8} autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} /></Field>
        <Field label="Confirm new password"><input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <div><button className="primary" type="submit" disabled={busy}>Update password</button></div>
      </form>
    </Page>
  );
}
