import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { loadEnv } from '../src/config/env.js';
import { createWorkerApp } from '../src/http/workerApp.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.close(); });

describe('PROCESS_ROLE', () => {
  it('defaults to all and accepts only api, worker or all', () => {
    expect(loadEnv({ ...TEST_ENV }).PROCESS_ROLE).toBe('all');
    expect(loadEnv({ ...TEST_ENV, PROCESS_ROLE: 'worker' }).PROCESS_ROLE).toBe('worker');
    expect(() => loadEnv({ ...TEST_ENV, PROCESS_ROLE: 'both' })).toThrow(/PROCESS_ROLE/);
  });
});

describe('api readiness with a separate worker', () => {
  it('is unavailable with no fresh heartbeat from ANY worker, and ready once another process beats', async () => {
    await t.pool.query('TRUNCATE worker_heartbeats');
    const down = await request(t.app).get('/readyz');
    expect(down.status).toBe(503);
    expect(down.body.checks).toEqual({ db: true, migrations: true, worker: false });
    await t.pool.query("INSERT INTO worker_heartbeats (worker_id, seen_at) VALUES ('worker-in-another-container', now())"); // not this process's id
    expect((await request(t.app).get('/readyz')).status).toBe(200);
    await t.pool.query("UPDATE worker_heartbeats SET seen_at = now() - interval '5 minutes'");
    expect((await request(t.app).get('/readyz')).status).toBe(503);
  });
});

describe('worker process surface', () => {
  it('answers health and readiness only: no API routes, no web app', async () => {
    const app = createWorkerApp(t.c);
    expect((await request(app).get('/healthz')).body).toEqual({ status: 'ok', role: 'worker' });
    for (const path of ['/api/products', '/api/public/catalog', '/webhooks/meta', '/', '/shop']) expect((await request(app).get(path)).status, path).toBe(404);
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(404);
  });

  it('is ready only when its OWN job loop is beating', async () => {
    const app = createWorkerApp(t.c);
    await t.pool.query('TRUNCATE worker_heartbeats');
    await t.pool.query("INSERT INTO worker_heartbeats (worker_id) VALUES ('someone-else')");
    expect((await request(app).get('/readyz')).status).toBe(503); // another worker beating does not make this one healthy
    await t.c.jobs.heartbeat();
    const ok = await request(app).get('/readyz');
    expect(ok.status).toBe(200);
    expect(ok.body.checks).toEqual({ db: true, migrations: true, worker: true });
  });

  it('stopping a queue that was never started (an api process shutting down) is harmless', async () => {
    const other = await buildTestApp();
    try { await expect(other.c.jobs.stop()).resolves.not.toThrow(); } finally { await other.close(); }
  });
});
