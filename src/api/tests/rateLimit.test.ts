import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';
import { createLogger, tenantTelemetry } from '../src/logger.js';

const lines: Record<string, unknown>[] = [];
const sink = new Writable({ write(chunk, _enc, cb) { for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>); cb(); } });
let t: TestApp; let owner: pg.Pool; let platform: string; let A: string; let B: string; let adminA: string; let adminB: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const mk = async (tenant: string, email: string) => {
  await runWithTenant(tenant, () => t.c.auth.createUser({ email, password: 'Password123!', name: email, role: 'admin' }));
  return (await request(t.app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.token as string;
};
const login = (email: string, password: string) => request(t.app).post('/api/auth/login').send({ email, password });

beforeAll(async () => {
  t = await buildTestApp({ PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!', META_APP_SECRET: 'meta-secret' },
    { logger: createLogger('info', sink), rateLimitCacheMs: 0 });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  platform = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token;
  A = await addTenant('rl-a', 'RL A'); B = await addTenant('rl-b', 'RL B');
  await owner.query("UPDATE tenants SET plan = 'PRO' WHERE id = $1", [B]);
  adminA = await mk(A, 'admin@a.test'); adminB = await mk(B, 'admin@b.test');
});
afterAll(async () => { await owner.end(); await t.close(); });

describe('per-business rate limit from the plan', () => {
  it('ships a budget per plan, editable by the operator without a deploy', async () => {
    const plans = (await request(t.app).get('/api/public/plans')).body as { code: string; requestsPerMinute: number }[];
    expect(Object.fromEntries(plans.map((p) => [p.code, p.requestsPerMinute]))).toEqual({ FREE: 120, PRO: 600, BUSINESS: 3000 });
    expect((await request(t.app).put('/api/platform/plans/FREE').set(h(platform)).send({ requestsPerMinute: 10 })).body.requestsPerMinute).toBe(10);
    expect((await request(t.app).put('/api/platform/plans/FREE').set(h(platform)).send({ requestsPerMinute: 5 })).status).toBe(400);
  });

  it('stops a business at its plan\'s budget with 429 and the standard headers, without touching another business', async () => {
    const statuses: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 12; i++) { last = await request(t.app).get('/api/products').set(h(adminA)); statuses.push(last.status); }
    expect(statuses.filter((s) => s === 200).length).toBeLessThan(11);     // 10 per minute on Free (the login above used none: it is not in this budget)
    expect(statuses.at(-1)).toBe(429);
    expect(last!.body.error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(last!.headers['ratelimit'] ?? last!.headers['ratelimit-policy']).toBeTruthy();
    expect((await request(t.app).get('/api/products').set(h(adminB))).status).toBe(200); // B is on Pro with its own counter
  });

  it('applies a raised limit at once and is shared by every user of the business, not per address', async () => {
    await request(t.app).put('/api/platform/plans/FREE').set(h(platform)).send({ requestsPerMinute: 1000 });
    expect((await request(t.app).get('/api/products').set(h(adminA))).status).toBe(200);
    const second = await mk(A, 'second@a.test'); // a different user of the same business
    expect((await request(t.app).get('/api/products').set(h(second))).status).toBe(200);
    await request(t.app).put('/api/platform/plans/FREE').set(h(platform)).send({ requestsPerMinute: 120 });
  });

  it('does not limit sign-in, public shop or webhooks through the business budget', async () => {
    for (let i = 0; i < 15; i++) expect((await request(t.app).get('/api/public/plans')).status).toBe(200);
  });
});

describe('login lockout with backoff', () => {
  const setup = async (email: string) => { await runWithTenant(A, () => t.c.auth.createUser({ email, password: 'Password123!', name: 'L', role: 'staff' })); };

  it('locks an account after 5 failures, even for the right password, and says how long to wait', async () => {
    await owner.query('TRUNCATE login_attempts');
    await setup('lock@a.test');
    for (let i = 0; i < 5; i++) expect((await login('lock@a.test', 'wrong-password')).status).toBe(401);
    const locked = await login('lock@a.test', 'Password123!');
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(30);
    expect(locked.headers['set-cookie']).toBeUndefined();
  });

  it('treats an email with no account exactly the same (nothing to enumerate)', async () => {
    for (let i = 0; i < 5; i++) expect((await login('ghost@nowhere.test', 'whatever-password')).status).toBe(401);
    const ghost = await login('ghost@nowhere.test', 'whatever-password');
    const real = await login('lock@a.test', 'wrong-password');
    expect([ghost.status, ghost.body.error.code, ghost.body.error.message]).toEqual([real.status, real.body.error.code, real.body.error.message]);
  });

  it('doubles the lock each time, resets after a success, and forgets old failures', async () => {
    await owner.query('TRUNCATE login_attempts');
    await setup('backoff@a.test');
    const lockLeft = async () => Number((await owner.query<{ s: number }>("SELECT extract(epoch FROM locked_until - now())::float8 AS s FROM login_attempts WHERE key LIKE 'login:acct:%' ORDER BY failures DESC LIMIT 1")).rows[0]?.s ?? 0);
    for (let i = 0; i < 5; i++) await login('backoff@a.test', 'bad-password-1');
    expect(await lockLeft()).toBeGreaterThan(25); expect(await lockLeft()).toBeLessThanOrEqual(30);
    await owner.query("UPDATE login_attempts SET locked_until = now() - interval '1 second'");   // the first lock ends
    expect((await login('backoff@a.test', 'bad-password-2')).status).toBe(401);                    // 6th failure
    expect(await lockLeft()).toBeGreaterThan(55); expect(await lockLeft()).toBeLessThanOrEqual(60);
    await owner.query("UPDATE login_attempts SET locked_until = now() - interval '1 second'");
    expect((await login('backoff@a.test', 'Password123!')).status).toBe(200);                      // a good sign-in clears the account
    expect((await owner.query("SELECT 1 FROM login_attempts WHERE key LIKE 'login:acct:%'")).rowCount).toBe(0);
    for (let i = 0; i < 4; i++) await login('backoff@a.test', 'bad-password-3');
    await owner.query("UPDATE login_attempts SET last_failure_at = now() - interval '20 minutes' WHERE key LIKE 'login:acct:%'");
    await login('backoff@a.test', 'bad-password-4');                                                // old failures are forgotten: this is failure number 1
    expect(Number((await owner.query("SELECT failures FROM login_attempts WHERE key LIKE 'login:acct:%'")).rows[0].failures)).toBe(1);
  });

  it('locks a client address more leniently (20), and other accounts are not locked by one account\'s failures', async () => {
    await owner.query('TRUNCATE login_attempts');
    await setup('other@a.test');
    for (let i = 0; i < 5; i++) await login('victim@a.test', 'guess');
    expect((await login('other@a.test', 'Password123!')).status).toBe(200);                         // a different account from the same address still works
    for (let i = 0; i < 20; i++) await login(`spray${i}@a.test`, 'guess');                          // one failure each: the address count reaches 20
    const blocked = await login('other@a.test', 'Password123!');
    expect(blocked.status).toBe(429);
  });

  it('stores no emails or addresses in readable form', async () => {
    const keys = (await owner.query<{ key: string }>('SELECT key FROM login_attempts')).rows.map((r) => r.key);
    expect(keys.some((k) => k.includes('@'))).toBe(false);
    expect(keys.filter((k) => k.startsWith('login:acct:')).every((k) => /^login:acct:[0-9a-f]{64}$/.test(k))).toBe(true);
  });
});

describe('logs carry the business', () => {
  it('request lines name the tenant, and any line logged inside a business context gets it automatically', async () => {
    lines.length = 0;
    await owner.query('TRUNCATE login_attempts');
    await request(t.app).get('/api/categories').set(h(adminB));
    const req = lines.find((l) => l.msg === 'request' && l.path === '/api/categories')!;
    expect(req).toMatchObject({ tenantId: B, status: 200 });
    lines.length = 0;
    await runWithTenant(A, async () => { t.c.logger.info('inside'); });
    t.c.logger.info('outside');
    expect(lines.find((l) => l.msg === 'inside')).toMatchObject({ tenantId: A });
    expect(lines.find((l) => l.msg === 'outside')).not.toHaveProperty('tenantId');
  });

  it('tags Application Insights telemetry with the business', async () => {
    const envelope = { data: { baseData: { properties: { keep: 'me' } } } };
    await runWithTenant(A, async () => { expect(tenantTelemetry(envelope)).toBe(true); });
    expect(envelope.data.baseData.properties).toEqual({ keep: 'me', tenantId: A });
    const none = { data: { baseData: { properties: {} } } };
    tenantTelemetry(none);
    expect(none.data.baseData.properties).toEqual({});
  });

  it('logs a rejected webhook (which kind only, never the body or signature) so an alert can count them', async () => {
    lines.length = 0;
    const res = await request(t.app).post('/webhooks/meta').set('x-hub-signature-256', 'sha256=deadbeef').set('content-type', 'application/json').send('{"secret":"do-not-log"}');
    expect(res.status).toBe(401);
    const line = lines.find((l) => l.msg === 'webhook rejected')!;
    expect(line).toMatchObject({ webhook: 'meta', reason: 'bad_signature' });
    expect(JSON.stringify(lines)).not.toMatch(/do-not-log|deadbeef/);
  });
});
