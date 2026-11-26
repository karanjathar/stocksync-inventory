import { Router } from 'express';
import type { Container } from '../../container.js';
import { requireRole } from '../middleware/auth.js';

/** Operations status for admins: is the background machinery keeping up? */
export function opsRoutes(c: Container): Router {
  const r = Router();
  r.get('/status', requireRole('admin'), async (_req, res) => {
    const [counts, oldest, failed, queued, maintenance] = await Promise.all([
      c.pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM jobs WHERE tenant_id = current_tenant() GROUP BY status'),
      c.pool.query<{ age: number }>("SELECT COALESCE(floor(GREATEST(0, extract(epoch FROM now() - min(run_at)))), 0)::int AS age FROM jobs WHERE status = 'pending' AND run_at <= now() AND tenant_id = current_tenant()"),
      c.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM channel_messages WHERE direction = 'out' AND status = 'failed' AND COALESCE(status_at, created_at) > now() - interval '24 hours'"),
      c.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM channel_messages WHERE direction = 'out' AND status = 'queued'"),
      c.pool.query<{ task: string; ranAt: string; result: unknown }>('SELECT task, ran_at AS "ranAt", result FROM maintenance_runs ORDER BY task'),
    ]);
    const n = (s: string) => counts.rows.find((row) => row.status === s)?.n ?? 0;
    res.json({
      queue: { pending: n('pending'), running: n('running'), dead: n('dead'), oldestPendingSec: oldest.rows[0]?.age ?? 0 },
      messages: { failed24h: failed.rows[0]?.n ?? 0, queued: queued.rows[0]?.n ?? 0 },
      maintenance: maintenance.rows,
    });
  });
  return r;
}
