import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { createPool } from '../src/db/pool.js';
import { loadEnv } from '../src/config/env.js';
import { TEST_DATABASE_URL } from './helpers/db.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.c.jobs.stop(); await t.close(); });
const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('/readyz', () => {
  it('is 503 naming the failing check while the job worker has not started, and /healthz stays a cheap liveness probe', async () => {
    const res = await request(t.app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { db: true, migrations: true, worker: false } });
    expect((await request(t.app).get('/healthz')).status).toBe(200);
  });

  it('is 200 once the worker is heartbeating, and 503 again when the heartbeat goes stale', async () => {
    t.c.jobs.start({ concurrency: 1, pollMs: 50 });
    await sleep(200);
    const ok = await request(t.app).get('/readyz');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ready', checks: { db: true, migrations: true, worker: true } });
    await t.c.jobs.stop();
    await t.pool.query("UPDATE worker_heartbeats SET seen_at = now() - interval '5 minutes'");
    const stale = await request(t.app).get('/readyz');
    expect(stale.status).toBe(503);
    expect(stale.body.checks.worker).toBe(false);
  });

  it('is 503 with migrations:false when a migration has not been applied', async () => {
    t.c.jobs.start({ concurrency: 1, pollMs: 50 });
    await sleep(150);
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL }); // migration history is owner-only
    await owner.query("UPDATE schema_migrations SET name = 'zzz_renamed.sql' WHERE name = '005_outbox_jobs.sql'");
    const res = await request(t.app).get('/readyz');
    await owner.query("UPDATE schema_migrations SET name = '005_outbox_jobs.sql' WHERE name = 'zzz_renamed.sql'");
    await owner.end();
    await t.c.jobs.stop();
    expect(res.status).toBe(503);
    expect(res.body.checks).toMatchObject({ db: true, migrations: false });
  });

  it('is 503 with db:false when the database is unreachable (no error details leaked)', async () => {
    const pool = createPool({ connectionString: TEST_DATABASE_URL, ssl: false });
    await pool.end();
    const app = createApp(createContainer({ env: loadEnv({ ...TEST_ENV }), pool }));
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.checks).toMatchObject({ db: false, migrations: false, worker: false });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|postgres|password/i);
  });
});

describe('GET /api/ops/status', () => {
  it('is admin-only', async () => {
    expect((await request(t.app).get('/api/ops/status')).status).toBe(401);
    expect((await request(t.app).get('/api/ops/status').set(auth(await t.token('staff')))).status).toBe(403);
    expect((await request(t.app).get('/api/ops/status').set(auth(await t.token('viewer')))).status).toBe(403);
  });

  it('reports queue depth, message health and the last maintenance runs', async () => {
    await t.pool.query('TRUNCATE jobs, channel_messages, maintenance_runs');
    await t.pool.query(`INSERT INTO jobs (kind, status, run_at, tenant_id) VALUES ('a','pending', now() - interval '120 seconds', current_tenant()), ('a','pending', now(), current_tenant()), ('a','running', now(), current_tenant()), ('a','dead', now(), current_tenant()), ('a','done', now(), current_tenant())`);
    await t.pool.query(`INSERT INTO channel_messages (channel, direction, external_user, text, status, created_at) VALUES
      ('whatsapp','out','1','f1','failed', now()), ('whatsapp','out','1','f2','failed', now() - interval '30 hours'),
      ('whatsapp','out','1','q','queued', now()), ('whatsapp','in','1','in','ok', now())`);
    await t.pool.query(`INSERT INTO maintenance_runs (task, ran_at, result) VALUES ('prune', now(), '{"messagesDeleted":3}')`);
    const res = await request(t.app).get('/api/ops/status').set(auth(await t.token('admin')));
    expect(res.status).toBe(200);
    expect(res.body.queue).toMatchObject({ pending: 2, running: 1, dead: 1 });
    expect(res.body.queue.oldestPendingSec).toBeGreaterThanOrEqual(119);
    expect(res.body.messages).toEqual({ failed24h: 1, queued: 1 });
    expect(res.body.maintenance).toEqual([expect.objectContaining({ task: 'prune', result: { messagesDeleted: 3 } })]);
  });

  it('reports an idle queue as oldestPendingSec 0', async () => {
    await t.pool.query('TRUNCATE jobs');
    const res = await request(t.app).get('/api/ops/status').set(auth(await t.token('admin')));
    expect(res.body.queue).toEqual({ pending: 0, running: 0, dead: 0, oldestPendingSec: 0 });
  });
});
