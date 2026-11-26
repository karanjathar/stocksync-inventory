import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay } from './helpers/fakeRazorpay.js';
import { JobQueue } from '../src/jobs/queue.js';
import { scheduleDue } from '../src/jobs/scheduler.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
const sent: { to: string; text: string }[] = [];

beforeAll(async () => {
  t = await buildTestApp(RZP, { fetch: fakeRazorpay().fn, messenger: { send: async (_c, to, text) => { sent.push({ to, text }); } } });
  const staff = await t.token('staff');
  ids = await seedCatalog(t, staff);
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 100 }, null);
  await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id });
});
afterAll(async () => { await t.close(); });

const ago = (id: string, hours: number) => t.pool.query("UPDATE orders SET created_at = now() - make_interval(hours => $2) WHERE id = $1", [id, hours]);
async function order(who: string, method: 'ONLINE' | 'COD', ageHours: number, channel: 'whatsapp' | 'web' = 'whatsapp') {
  const customerId = (await t.c.customers.findOrCreateByChannel(channel, who, who)).id;
  const o = await t.c.orders.create({ customerId, channel, paymentMethod: method, items: [{ productId: ids.tee.id, quantity: 1 }] });
  await ago(o.id, ageHours);
  return o;
}
const status = async (id: string) => (await t.c.orders.get(id))!.status;

describe('expire unpaid online orders', () => {
  it('cancels only old UNPAID ONLINE PENDING orders and tells the chat customer', async () => {
    await t.c.settings.update({ maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 365 } });
    const old = await order('91111', 'ONLINE', 72);
    const fresh = await order('91112', 'ONLINE', 5);
    const cod = await order('91113', 'COD', 200);
    const paid = await order('91114', 'ONLINE', 72);
    await t.pool.query("UPDATE orders SET payment_status = 'PAID' WHERE id = $1", [paid.id]);
    const confirmed = await order('91115', 'ONLINE', 72);
    await t.c.orders.confirm(confirmed.id, ids.main.id, null);
    sent.length = 0;

    const res = await t.c.maintenance.expireUnpaid();
    expect(res).toEqual({ cancelled: 1 });
    expect(await status(old.id)).toBe('CANCELLED');
    for (const o of [fresh, cod, paid, confirmed]) expect(await status(o.id)).not.toBe('CANCELLED');
    expect(sent.some((m) => m.to === '91111' && /cancelled/.test(m.text))).toBe(true);
    expect((await t.pool.query("SELECT result FROM maintenance_runs WHERE task = 'expireUnpaid'")).rows[0].result).toEqual({ cancelled: 1 });
  });

  it('respects the TTL setting', async () => {
    await t.c.settings.update({ maintenance: { unpaidOrderTtlHours: 2, chatRetentionDays: 365 } });
    const o = await order('91116', 'ONLINE', 3);
    const young = await order('91117', 'ONLINE', 1);
    expect((await t.c.maintenance.expireUnpaid()).cancelled).toBe(2); // this order and the 5 h old one from the previous test
    expect(await status(o.id)).toBe('CANCELLED');
    expect(await status(young.id)).toBe('PENDING');
  });
});

describe('prune', () => {
  it('deletes old webhook events and old chat messages, but never orders, movements or queued messages', async () => {
    await t.c.settings.update({ maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 30 } });
    await t.pool.query("TRUNCATE channel_messages, webhook_events, jobs");
    await t.pool.query(`INSERT INTO webhook_events (provider, event_id, received_at) VALUES ('razorpay','old', now() - interval '31 days'), ('razorpay','new', now() - interval '29 days')`);
    await t.pool.query(`INSERT INTO channel_messages (channel, direction, external_user, text, status, created_at) VALUES
      ('whatsapp','in','1','old in','ok', now() - interval '40 days'), ('whatsapp','out','1','old out','sent', now() - interval '40 days'),
      ('whatsapp','out','1','old queued','queued', now() - interval '40 days'), ('whatsapp','in','1','recent','ok', now() - interval '5 days')`);
    const before = (await t.pool.query('SELECT (SELECT count(*) FROM orders) o, (SELECT count(*) FROM stock_movements) m')).rows[0];

    expect(await t.c.maintenance.prune()).toEqual({ webhookEventsDeleted: 1, messagesDeleted: 2 });
    expect((await t.pool.query('SELECT event_id FROM webhook_events')).rows).toEqual([{ event_id: 'new' }]);
    expect((await t.pool.query('SELECT text FROM channel_messages ORDER BY text')).rows.map((r) => r.text)).toEqual(['old queued', 'recent']);
    expect((await t.pool.query('SELECT (SELECT count(*) FROM orders) o, (SELECT count(*) FROM stock_movements) m')).rows[0]).toEqual(before);
  });

  it('keeps all chat history when retention is 0', async () => {
    await t.c.settings.update({ maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 0 } });
    await t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status, created_at) VALUES ('whatsapp','in','1','ancient','ok', now() - interval '900 days')");
    expect((await t.c.maintenance.prune()).messagesDeleted).toBe(0);
  });
});

describe('scheduler', () => {
  it('enqueues due tasks once, never while one is pending, and not when they ran recently', async () => {
    await t.pool.query('TRUNCATE jobs, maintenance_runs');
    const q = new JobQueue(t.pool, { workerId: 'w' });
    expect((await scheduleDue(t.pool, q)).sort()).toEqual(['expireUnpaid', 'prune']);
    expect(await scheduleDue(t.pool, q)).toEqual([]); // already pending (two replicas ticking together)
    await t.pool.query("TRUNCATE jobs");
    await t.pool.query("INSERT INTO maintenance_runs (task, ran_at, result) VALUES ('expireUnpaid', now() - interval '10 minutes', '{}'), ('prune', now() - interval '25 hours', '{}')");
    expect(await scheduleDue(t.pool, q)).toEqual(['prune']);
    await t.pool.query("TRUNCATE jobs; UPDATE maintenance_runs SET ran_at = now() - interval '61 minutes' WHERE task = 'expireUnpaid'");
    expect(await scheduleDue(t.pool, q)).toEqual(['expireUnpaid', 'prune']);
  });

  it('runs both tasks through the job handlers', async () => {
    await t.pool.query('TRUNCATE jobs, maintenance_runs');
    const q = new JobQueue(t.pool, { workerId: 'w' });
    t.c.maintenance.register(q);
    await scheduleDue(t.pool, q);
    expect(await q.runOnce(5)).toBe(2);
    expect((await t.pool.query('SELECT task FROM maintenance_runs ORDER BY task')).rows).toEqual([{ task: 'expireUnpaid' }, { task: 'prune' }]);
  });
});
