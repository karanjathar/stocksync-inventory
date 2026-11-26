import { useState } from 'react';
import { useApi } from '../hooks';
import { dateTime } from '../format';
import { Card, Empty, ErrorBanner, Page } from '../components/ui';

interface Entry { id: string; at: string; actor: string; action: string; entityId: string | null; detail: { fields?: string[]; values?: Record<string, unknown> } }
interface Page { entries: Entry[]; next: string | null }

/** Who changed what in this business. Read-only: the history cannot be edited or deleted by anyone in the app. */
export function AuditLog() {
  const [before, setBefore] = useState<string[]>([]); // cursors of the pages we moved past, so Back works
  const [action, setAction] = useState('');
  const cursor = before.at(-1);
  const qs = new URLSearchParams({ limit: '50', ...(cursor ? { before: cursor } : {}), ...(action.trim() ? { action: action.trim() } : {}) });
  const { data, error } = useApi<Page>(`/audit-log?${qs.toString()}`);
  return (
    <Page title="Activity log">
      <ErrorBanner error={error} />
      <Card>
        <label>Filter by action <input value={action} onChange={(e) => { setAction(e.target.value); setBefore([]); }} placeholder="e.g. settings" /></label>
        {data && !data.entries.length && <Empty>No activity recorded yet.</Empty>}
        {data && data.entries.length > 0 && (
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td>{dateTime(e.at)}</td><td>{e.actor}</td><td>{e.action}</td>
                  <td className="muted small">{e.detail.values ? Object.entries(e.detail.values).map(([k, v]) => `${k}: ${String(v)}`).join(', ') : (e.detail.fields ?? []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row">
          <button type="button" disabled={!before.length} onClick={() => setBefore((b) => b.slice(0, -1))}>Newer</button>
          <button type="button" disabled={!data?.next} onClick={() => data?.next && setBefore((b) => [...b, data.next!])}>Older</button>
        </div>
      </Card>
    </Page>
  );
}
