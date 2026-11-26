import express, { type Express } from 'express';
import type { Container } from '../container.js';
import { pendingMigrations } from '../db/migrate.js';

/**
 * What a worker process exposes: liveness and readiness only, no API routes and no static files. Ready means the database answers,
 * migrations are applied and THIS process's own job loop has beaten recently (so a stuck worker is restarted by its probe).
 */
export function createWorkerApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok', role: 'worker' }); });
  app.get('/readyz', async (_req, res) => {
    const checks = { db: false, migrations: false, worker: false };
    try {
      await c.pool.query('SELECT 1');
      checks.db = true;
      checks.migrations = (await pendingMigrations(c.pool)).length === 0;
      checks.worker = ((await c.pool.query("SELECT 1 FROM worker_heartbeats WHERE worker_id = $1 AND seen_at > now() - interval '60 seconds'", [c.jobs.workerId])).rowCount ?? 0) > 0;
    } catch { /* a failed check stays false */ }
    const ready = checks.db && checks.migrations && checks.worker;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
  });
  return app;
}
