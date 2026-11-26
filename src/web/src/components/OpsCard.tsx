import { useApi } from '../hooks';
import { useAuth } from '../auth';
import { dateTime } from '../format';
import { Badge, Card } from './ui';

interface OpsStatus {
  queue: { pending: number; running: number; dead: number; oldestPendingSec: number };
  messages: { failed24h: number; queued: number };
  maintenance: { task: string; ranAt: string; result: Record<string, number> }[];
}

/** Admin-only health of the background machinery: queue, failed messages, last cleanup runs. */
export function OpsCard() {
  const { can } = useAuth();
  const admin = can('admin');
  const status = useApi<OpsStatus>(admin ? '/ops/status' : null);
  if (!admin || !status.data) return null;
  const { queue, messages, maintenance } = status.data;
  const lagging = queue.oldestPendingSec > 300 || queue.dead > 0;
  return (
    <Card title="System health">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Badge tone={lagging ? 'bad' : 'good'}>{lagging ? 'Needs attention' : 'Healthy'}</Badge>
        <span>Queue: {queue.pending} waiting · {queue.running} running · {queue.dead} stuck</span>
        <span>Oldest waiting: {queue.oldestPendingSec}s</span>
        <span><Badge tone={messages.failed24h > 0 ? 'warn' : 'neutral'}>{messages.failed24h}</Badge> failed messages (24 h)</span>
        <span>{messages.queued} messages queued</span>
      </div>
      <p className="small muted">
        {maintenance.length ? maintenance.map((m) => `${m.task}: ${dateTime(m.ranAt)}`).join(' · ') : 'Cleanup jobs have not run yet.'}
      </p>
    </Card>
  );
}
