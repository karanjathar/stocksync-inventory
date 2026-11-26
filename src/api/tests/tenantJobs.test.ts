import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { addTenant } from './helpers/db.js';
import { currentTenantId, runWithTenant } from '../src/db/tenant.js';
import { JobQueue } from '../src/jobs/queue.js';
import { scheduleDue } from '../src/jobs/scheduler.js';
import { EventBus } from '../src/realtime/bus.js';
import type { RealtimeEvent } from '../src/domain/types.js';

/** Background work, live events and the ops view all belong to one business at a time (T92). */
let t: TestApp; let A: string; let B: string; let server: Server; let base: string;
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const tenantToken = async (tenant: string, email: string, role: 'admin' | 'staff' = 'admin') => {
  await inTenant(tenant, () => t.c.auth.createUser({ email, password: 'Password123!', name: email, role }));
  return (await request(t.app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.token as string;
};

beforeAll(async () => {
  t = await buildTestApp({ PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!', ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') },
    { fetch: (async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.T' }] }), { status: 200 })) as typeof fetch });
  A = await addTenant('shop-a', 'Shop A'); B = await addTenant('shop-b', 'Shop B');
  // Each business sends with its OWN WhatsApp credentials (the server's environment keys belong to the default business only).
  for (const tenant of [A, B]) await inTenant(tenant, () => t.c.channelCredentials.set('whatsapp', { token: `tok-${tenant.slice(0, 4)}`, phoneNumberId: '990' }));
  server = t.app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); server.close(); await t.close(); });

describe('jobs remember their business and run as it', () => {
  it('a job enqueued in business A runs inside A, whoever picks it up', async () => {
    const q = new JobQueue(t.pool, { workerId: 'w' });
    const seen: { tenant: string | undefined; products: number }[] = [];
    q.register('probe', async () => { seen.push({ tenant: currentTenantId(), products: (await t.pool.query('SELECT 1 FROM products')).rowCount ?? 0 }); });
    await inTenant(A, () => t.pool.query("INSERT INTO products (sku, name, price_cents) VALUES ('JA', 'a', 1)"));
    await inTenant(B, async () => { await t.pool.query("INSERT INTO products (sku, name, price_cents) VALUES ('JB1', 'b', 1), ('JB2', 'b', 1)"); });
    await inTenant(A, () => q.enqueue('probe', {}));
    await inTenant(B, () => q.enqueue('probe', {}));
    await q.runOnce(5); // the worker has no tenant of its own
    expect(seen.sort((x, y) => (x.products - y.products))).toEqual([{ tenant: A, products: 1 }, { tenant: B, products: 2 }]);
    expect((await t.pool.query('SELECT tenant_id FROM jobs ORDER BY id DESC LIMIT 2')).rows.map((r) => r.tenant_id).sort()).toEqual([A, B].sort());
  });

  it('the same dedupe key in two businesses is two jobs; within one business it is one', async () => {
    const q = new JobQueue(t.pool, { workerId: 'w' });
    await t.pool.query('TRUNCATE jobs');
    expect(await inTenant(A, () => q.enqueue('dedupe', {}, { dedupeKey: 'k' }))).not.toBeNull();
    expect(await inTenant(B, () => q.enqueue('dedupe', {}, { dedupeKey: 'k' }))).not.toBeNull();
    expect(await inTenant(A, () => q.enqueue('dedupe', {}, { dedupeKey: 'k' }))).toBeNull();
  });

  it('a queued message is delivered by the worker for the business that sent it', async () => {
    await t.pool.query('TRUNCATE jobs');
    await inTenant(B, () => t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status, payload) VALUES ('whatsapp','out','1555','queued for B','queued','{\"kind\":\"text\",\"text\":\"queued for B\"}')"));
    await inTenant(B, () => t.pool.query("INSERT INTO jobs (kind, payload, tenant_id, run_at) SELECT 'message.send', jsonb_build_object('messageId', id), tenant_id, now() FROM channel_messages WHERE text = 'queued for B'"));
    await t.c.jobs.runOnce(5);
    expect((await inTenant(B, () => t.pool.query("SELECT status FROM channel_messages WHERE text = 'queued for B'"))).rows[0].status).toBe('sent');
    expect((await inTenant(A, () => t.pool.query("SELECT 1 FROM channel_messages WHERE text = 'queued for B'"))).rowCount).toBe(0);
  });

  it('outbox jobs created by the hub carry the sender\'s business', async () => {
    await t.pool.query('TRUNCATE jobs');
    await inTenant(A, () => t.c.hub.send('whatsapp', '1555', 'hello from A'));
    // A sends immediately; force a retry path by inserting directly through the repo helper
    await inTenant(A, () => t.c.messages.createOutbound({ channel: 'whatsapp', to: '1555', text: 'durable', payload: { kind: 'text', text: 'durable' }, status: 'queued' }));
    expect((await t.pool.query("SELECT tenant_id FROM jobs WHERE kind = 'message.send'")).rows.every((r) => r.tenant_id === A)).toBe(true);
  });
});

describe('the scheduler works through every business', () => {
  it('enqueues each business\'s maintenance separately, and each run uses that business\'s own settings', async () => {
    await t.pool.query('TRUNCATE jobs');
    await inTenant(A, () => t.pool.query("DELETE FROM maintenance_runs"));
    await inTenant(B, () => t.pool.query("DELETE FROM maintenance_runs"));
    const q = new JobQueue(t.pool, { workerId: 'w' });
    t.c.maintenance.register(q);
    // A keeps chat for 30 days, B keeps it forever
    await inTenant(A, () => t.c.settings.update({ maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 30 } }));
    await inTenant(B, () => t.c.settings.update({ maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 0 } }));
    for (const tenant of [A, B]) await inTenant(tenant, () => t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status, created_at) VALUES ('whatsapp','in','1','ancient','ok', now() - interval '90 days')"));

    expect((await scheduleDue(t.pool, q, [A, B])).sort()).toEqual(['expireUnpaid', 'expireUnpaid', 'prune', 'prune']);
    expect((await t.pool.query('SELECT tenant_id, kind FROM jobs ORDER BY id')).rows).toHaveLength(4);
    expect(await scheduleDue(t.pool, q, [A, B])).toEqual([]); // already queued for both
    await q.runOnce(10);
    expect((await inTenant(A, () => t.pool.query("SELECT 1 FROM channel_messages WHERE text = 'ancient'"))).rowCount).toBe(0);
    expect((await inTenant(B, () => t.pool.query("SELECT 1 FROM channel_messages WHERE text = 'ancient'"))).rowCount).toBe(1);
    expect((await inTenant(A, () => t.pool.query('SELECT task FROM maintenance_runs ORDER BY task'))).rows.map((r) => r.task)).toEqual(['expireUnpaid', 'prune']);
    expect(await scheduleDue(t.pool, q, [A, B])).toEqual([]); // both ran recently
  });
});

describe('live events stay inside their business', () => {
  const ev = (n: number): RealtimeEvent => ({ type: 'order.created', orderId: `o${n}`, number: n, status: 'PENDING' });

  it('a subscriber hears only its own business; unscoped internal subscribers hear everything', () => {
    const bus = new EventBus();
    const a: RealtimeEvent[] = []; const b: RealtimeEvent[] = []; const all: RealtimeEvent[] = [];
    bus.subscribe((e) => a.push(e), A); bus.subscribe((e) => b.push(e), B); bus.subscribe((e) => all.push(e));
    runWithTenant(A, () => bus.publish(ev(1)));
    runWithTenant(B, () => bus.publish(ev(2)));
    expect(a.map((e) => 'number' in e && e.number)).toEqual([1]);
    expect(b.map((e) => 'number' in e && e.number)).toEqual([2]);
    expect(all).toHaveLength(2);
  });

  it('an event with no business goes only to the configured fallback business', () => {
    const bus = new EventBus(A);
    const a: RealtimeEvent[] = []; const b: RealtimeEvent[] = [];
    bus.subscribe((e) => a.push(e), A); bus.subscribe((e) => b.push(e), B);
    bus.publish(ev(1));
    expect([a.length, b.length]).toEqual([1, 0]);
    const strict = new EventBus();
    const c: RealtimeEvent[] = [];
    strict.subscribe((e) => c.push(e), A);
    strict.publish(ev(2));
    expect(c).toHaveLength(0); // no context and no fallback: delivered to nobody
  });

  it('over SSE, business B never receives business A\'s events', async () => {
    const ta = await tenantToken(A, 'live@a.test'); const tb = await tenantToken(B, 'live@b.test');
    const open = async (tok: string) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events`, { headers: h(tok), signal: ac.signal });
      const reader = res.body!.getReader();
      let buf = '';
      const decoder = new TextDecoder();
      const pump = (async () => { for (;;) { const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true })); if (done) break; buf += decoder.decode(value); } })();
      return { text: () => buf, close: () => { ac.abort(); return pump; } };
    };
    const sa = await open(ta); const sb = await open(tb);
    await new Promise((r) => setTimeout(r, 100));
    await inTenant(A, async () => {
      const customer = await t.c.customers.findOrCreateByChannel('web', '9199', 'Live A');
      await t.pool.query("INSERT INTO products (sku, name, price_cents) VALUES ('LIVE', 'live', 1)");
      const p = (await t.pool.query('SELECT id FROM products WHERE sku = $1', ['LIVE'])).rows[0].id as string;
      await t.c.orders.create({ customerId: customer.id, channel: 'manual', items: [{ productId: p, quantity: 1 }] });
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(sa.text()).toContain('order.created');
    expect(sb.text()).not.toContain('order.created');
    await sa.close(); await sb.close();
  });
});

describe('the ops view is per business, and the platform sees the whole queue', () => {
  it('a business sees only its own queue and failures; platform staff see everything', async () => {
    await t.pool.query('TRUNCATE jobs, worker_heartbeats');
    await t.pool.query(`INSERT INTO jobs (kind, tenant_id, status, run_at) VALUES ('x', '${A}', 'pending', now() - interval '60 seconds'), ('x', '${A}', 'dead', now()),
      ('x', '${B}', 'pending', now()), ('x', '${B}', 'pending', now()), ('x', '${B}', 'running', now())`);
    await inTenant(B, () => t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status) VALUES ('whatsapp','out','1','b-failed','failed')"));
    const ta = await tenantToken(A, 'ops@a.test'); const tb = await tenantToken(B, 'ops@b.test');
    const statusA = (await request(t.app).get('/api/ops/status').set(h(ta))).body;
    const statusB = (await request(t.app).get('/api/ops/status').set(h(tb))).body;
    expect(statusA.queue).toMatchObject({ pending: 1, running: 0, dead: 1 });
    expect(statusB.queue).toMatchObject({ pending: 2, running: 1, dead: 0 });
    expect(statusA.messages.failed24h).toBe(0);
    expect(statusB.messages.failed24h).toBe(1);

    await t.pool.query("INSERT INTO worker_heartbeats (worker_id) VALUES ('w1')");
    const ops = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token as string;
    const platform = await request(t.app).get('/api/platform/queue').set(h(ops));
    expect(platform.status).toBe(200);
    expect(platform.body.queue).toMatchObject({ pending: 3, running: 1, dead: 1 });
    expect(platform.body.workers.map((w: { workerId: string }) => w.workerId)).toEqual(['w1']);
    expect((await request(t.app).get('/api/platform/queue').set(h(ta))).status).toBe(401);
    expect(jwt.decode(ops)).toMatchObject({ typ: 'platform' });
  });
});
