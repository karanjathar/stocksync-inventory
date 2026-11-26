import { useState, type FormEvent } from 'react';
import { api, getToken } from '../api/client';
import { useAction, useApi } from '../hooks';
import { dateTime } from '../format';
import { Card, ErrorBanner, Field } from '../components/ui';

interface Deletion { slug: string; requested: boolean; requestedAt: string | null; eraseAfter: string | null; holdDays: number }

/** Export everything, or ask for the whole business to be deleted after a 30-day hold. Administrators only (the server enforces it). */
export function DataRights() {
  const state = useApi<Deletion>('/data/deletion');
  const act = useAction();
  const [password, setPassword] = useState('');
  const [confirmSlug, setConfirmSlug] = useState('');
  const d = state.data;
  if (!d) return null; // quiet when not allowed or not available
  const slug = d.slug;

  const download = () => act.run(async () => {
    const res = await fetch('/api/data/export', { method: 'POST', headers: { authorization: `Bearer ${getToken() ?? ''}` } });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? `Export failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'stocksync-export.zip';
    a.click(); URL.revokeObjectURL(url);
  });
  const request = (e: FormEvent) => { e.preventDefault(); void act.run(async () => { await api('/data/deletion', { body: { password, confirmSlug } }); setPassword(''); state.reload(); }); };
  const cancel = () => act.run(async () => { await api('/data/deletion', { method: 'DELETE' }); state.reload(); });

  return (
    <Card title="Your data">
      <ErrorBanner error={act.error} />
      <p>Download everything in your business as a zip of spreadsheets (CSV). Passwords and access tokens are not included.</p>
      <button type="button" disabled={act.busy} onClick={() => void download()}>Download all my data</button>
      <hr />
      {d.requested ? (
        <div role="alert">
          <p><strong>Deletion requested.</strong> Everything will be permanently removed on {d.eraseAfter ? dateTime(d.eraseAfter) : 'the date shown'}. Until then you can use StockSync as normal or cancel.</p>
          <button type="button" disabled={act.busy} onClick={() => void cancel()}>Cancel deletion</button>
        </div>
      ) : (
        <form onSubmit={request} aria-label="Delete my business">
          <p>Delete this business and all its data. There is a {d.holdDays}-day wait during which you can change your mind. We recommend downloading your data first.</p>
          <Field label={`Type ${slug} to confirm`}><input value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} autoComplete="off" /></Field>
          <Field label="Your password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
          <button type="submit" className="danger" disabled={act.busy || confirmSlug !== slug || !password}>Request deletion</button>
        </form>
      )}
    </Card>
  );
}
