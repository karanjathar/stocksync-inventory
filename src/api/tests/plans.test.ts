import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { addTenant } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';

let t: TestApp; let platform: string; let A: string; let B: string; let adminA: string; let adminB: string; let staffA: string;
const sent: string[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  sent.push(`${String(input)} ${String(init?.body ?? '')}`);
  return Response.json({ messages: [{ id: `wamid.${sent.length}` }] });
}) as typeof fetch;
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const login = async (email: string) => (await request(t.app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.token as string;
const mk = async (tenant: string, email: string, role: 'admin' | 'staff') => {
  await inTenant(tenant, () => t.c.auth.createUser({ email, password: 'Password123!', name: email, role }));
  return login(email);
};
const editPlan = (code: string, body: object) => request(t.app).put(`/api/platform/plans/${code}`).set(h(platform)).send(body);
const product = (tok: string, n: number) => request(t.app).post('/api/products').set(h(tok)).send({ sku: `P${n}`, name: `Product ${n}`, priceCents: 100 });

beforeAll(async () => {
  t = await buildTestApp({ ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!' }, { fetch: fakeFetch });
  platform = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token;
  A = await addTenant('plan-a', 'Plan A'); B = await addTenant('plan-b', 'Plan B'); // new businesses start on FREE
  adminA = await mk(A, 'admin@a.test', 'admin'); adminB = await mk(B, 'admin@b.test', 'admin'); staffA = await mk(A, 'staff@a.test', 'staff');
});
afterAll(async () => { await t.close(); });

describe('plans', () => {
  it('ships Free, Pro and Business and lists them to anyone, prices in integer minor units', async () => {
    const res = await request(t.app).get('/api/public/plans');
    expect(res.status).toBe(200);
    expect(res.body.map((p: { code: string }) => p.code)).toEqual(['FREE', 'PRO', 'BUSINESS']);
    expect(res.body[1]).toMatchObject({ priceMinor: 99900, currency: 'INR', maxProducts: 2000 });
    expect(res.body[2]).toMatchObject({ maxProducts: null, maxUsers: null });
    expect(res.body.every((p: { priceMinor: number }) => Number.isInteger(p.priceMinor))).toBe(true);
  });

  it('leaves the original single-business deployment unlimited', async () => {
    const admin = await t.token('admin');
    const usage = await request(t.app).get('/api/usage').set(h(admin));
    expect(usage.body.plan).toMatchObject({ code: 'BUSINESS', maxProducts: null });
  });
});

describe('usage page data', () => {
  it('shows the plan, its limits and what the business has used; admins only; per business', async () => {
    await product(adminA, 1);
    const res = await request(t.app).get('/api/usage').set(h(adminA));
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ code: 'FREE', maxProducts: 50, maxUsers: 2 });
    expect(res.body.usage).toEqual({ products: 1, users: 2, chatMessages: 0, invoices: 0 });
    expect(res.body.period).toMatch(/^\d{4}-\d{2}$/);
    expect((await request(t.app).get('/api/usage').set(h(adminB))).body.usage.products).toBe(0);
    expect((await request(t.app).get('/api/usage').set(h(staffA))).status).toBe(403);
    expect((await request(t.app).get('/api/usage')).status).toBe(401);
  });
});

describe('limits stop new records and never delete anything', () => {
  it('users: the third user on Free is refused with the numbers needed for an upgrade prompt', async () => {
    const res = await request(t.app).post('/api/users').set(h(adminA)).send({ email: 'third@a.test', password: 'Password123!', name: 'Third', role: 'staff' });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'PLAN_LIMIT', details: { metric: 'users', limit: 2, used: 2, plan: 'Free' } });
    expect((await request(t.app).get('/api/users').set(h(adminA))).body).toHaveLength(2);
    expect((await request(t.app).post('/api/users').set(h(adminB)).send({ email: 'second@b.test', password: 'Password123!', name: 'S', role: 'staff' })).status).toBe(201); // B is separate
  });

  it('products: the operator changes a limit without a deploy and it applies immediately', async () => {
    const set = await editPlan('FREE', { maxProducts: 3 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ code: 'FREE', maxProducts: 3 });
    expect((await product(adminA, 2)).status).toBe(201);
    expect((await product(adminA, 3)).status).toBe(201);
    const blocked = await product(adminA, 4);
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.details).toEqual({ metric: 'products', limit: 3, used: 3, plan: 'Free' });
    expect((await editPlan('FREE', { maxProducts: 10 })).status).toBe(200);
    expect((await product(adminA, 4)).status).toBe(201);
  });

  it('downgrading below current use keeps every existing record and only blocks new ones', async () => {
    await editPlan('FREE', { maxProducts: 2 });
    expect((await request(t.app).get('/api/products').set(h(adminA))).body).toHaveLength(4); // still all there
    expect((await product(adminA, 5)).status).toBe(402);
    const usage = (await request(t.app).get('/api/usage').set(h(adminA))).body;
    expect(usage.usage.products).toBe(4);
    await editPlan('FREE', { maxProducts: 50 });
  });

  it('invoices: a new invoice beyond the monthly limit is refused and not created; re-reading an issued one is free', async () => {
    await editPlan('FREE', { maxInvoices: 1 });
    await request(t.app).put('/api/settings').set(h(adminA)).send({ currency: 'INR', gst: { legalName: 'A Ltd', gstin: '27AAPFU0939F1ZV', address: 'Street', stateCode: '27', invoicePrefix: 'AAA', pricesIncludeTax: true } });
    const wh = (await request(t.app).post('/api/warehouses').set(h(adminA)).send({ code: 'W', name: 'W' })).body.id;
    const cust = (await request(t.app).post('/api/customers').set(h(adminA)).send({ name: 'C' })).body.id;
    const prod = (await request(t.app).get('/api/products').set(h(adminA))).body[0].id;
    await inTenant(A, () => t.c.stock.receive({ productId: prod, warehouseId: wh, quantity: 50 }, null));
    const confirmed: string[] = [];
    for (let i = 0; i < 2; i++) {
      const o = (await request(t.app).post('/api/orders').set(h(adminA)).send({ customerId: cust, channel: 'manual', items: [{ productId: prod, quantity: 1 }] })).body.id;
      await request(t.app).post(`/api/orders/${o}/confirm`).set(h(adminA)).send({ warehouseId: wh });
      confirmed.push(o);
    }
    const first = await request(t.app).get(`/api/orders/${confirmed[0]}/invoice`).set(h(adminA));
    expect(first.status).toBe(200);
    expect((await request(t.app).get(`/api/orders/${confirmed[0]}/invoice`).set(h(adminA))).status).toBe(200); // already issued: not counted again
    const second = await request(t.app).get(`/api/orders/${confirmed[1]}/invoice`).set(h(adminA));
    expect(second.status).toBe(402);
    expect(second.body.error.details).toMatchObject({ metric: 'invoices', limit: 1, used: 1 });
    const count = (await inTenant(A, () => t.pool.query('SELECT count(*)::int AS n FROM invoices'))).rows[0].n;
    expect(count).toBe(1); // the refused invoice left nothing behind, and its number was not used
    expect((await request(t.app).get('/api/usage').set(h(adminA))).body.usage.invoices).toBe(1);
    await editPlan('FREE', { maxInvoices: 20 });
    expect((await request(t.app).get(`/api/orders/${confirmed[1]}/invoice`).set(h(adminA))).body.number).toMatch(/AAA/); // issued after the limit is raised
  });

  it('chat messages: sends beyond the monthly limit are stored as failed with PLAN_LIMIT, nothing is sent', async () => {
    await request(t.app).put('/api/channel-config/whatsapp').set(h(adminA)).send({ token: 'WA-TOKEN-AAAA', phoneNumberId: '111' });
    await editPlan('FREE', { maxChatMessages: 2 });
    sent.length = 0;
    for (const n of [1, 2, 3]) await inTenant(A, () => t.c.hub.send('whatsapp', '15550001', `message ${n}`));
    expect(sent.filter((s) => s.includes('graph.facebook.com'))).toHaveLength(2);
    const rows = (await inTenant(A, () => t.pool.query("SELECT text, status, error_code FROM channel_messages WHERE direction = 'out' ORDER BY created_at"))).rows;
    expect(rows.map((r) => [r.text, r.status, r.error_code])).toEqual([['message 1', 'sent', null], ['message 2', 'sent', null], ['message 3', 'failed', 'PLAN_LIMIT']]);
    expect((await request(t.app).get('/api/usage').set(h(adminA))).body.usage.chatMessages).toBe(2);
    await editPlan('FREE', { maxChatMessages: 200 });
  });
});

describe('metering is atomic', () => {
  it('twenty simultaneous sends against a limit of five count exactly five', async () => {
    await editPlan('FREE', { maxInvoices: 5 });
    const results = await Promise.all(Array.from({ length: 20 }, () => inTenant(B, () => t.c.plans.consume('invoices'))));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect((await request(t.app).get('/api/usage').set(h(adminB))).body.usage.invoices).toBe(5);
    await editPlan('FREE', { maxInvoices: 20 });
  });

  it('counters are per business and per month', async () => {
    const rows = (await t.pool.query('SELECT 1 FROM usage_counters')).rowCount; // default tenant context: sees only its own
    expect(rows).toBe(0);
    await expect(inTenant(B, () => t.pool.query("INSERT INTO usage_counters (metric, period, used) VALUES ('invoices', 'bad', 1)"))).rejects.toMatchObject({ code: '23514' });
  });
});

describe('operator console', () => {
  it('moves a business to another plan, rejects unknown plans, and needs a platform login', async () => {
    const tenantB = B;
    expect((await request(t.app).patch(`/api/platform/tenants/${tenantB}`).set(h(platform)).send({ plan: 'PRO' })).body.plan).toBe('PRO');
    expect((await request(t.app).get('/api/usage').set(h(adminB))).body.plan.code).toBe('PRO');
    expect((await request(t.app).patch(`/api/platform/tenants/${tenantB}`).set(h(platform)).send({ plan: 'NOPE' })).status).toBe(400);
    expect((await request(t.app).patch(`/api/platform/tenants/${tenantB}`).set(h(platform)).send({})).status).toBe(400);
    expect((await request(t.app).put('/api/platform/plans/FREE').set(h(adminA)).send({ maxProducts: 1 })).status).toBe(401); // a business token is not an operator
    expect((await editPlan('FREE', { maxProducts: -1 })).status).toBe(400);
    expect((await editPlan('free', { maxProducts: 1 })).status).toBe(400);
    expect((await editPlan('ENTERPRISE', { maxProducts: 10 })).status).toBe(400); // a new plan needs a name
    const created = await editPlan('ENTERPRISE', { name: 'Enterprise', priceMinor: 999900, maxProducts: null, maxUsers: null, maxChatMessages: null, maxInvoices: null, sort: 4 });
    expect(created.body).toMatchObject({ code: 'ENTERPRISE', priceMinor: 999900 });
    expect((await request(t.app).get('/api/public/plans')).body.map((p: { code: string }) => p.code)).toContain('ENTERPRISE');
    await editPlan('ENTERPRISE', { active: false });
    expect((await request(t.app).get('/api/public/plans')).body.map((p: { code: string }) => p.code)).not.toContain('ENTERPRISE');
  });

  it('the application role cannot change plans or its own business plan', async () => {
    await expect(inTenant(A, () => t.pool.query("UPDATE plans SET max_products = NULL WHERE code = 'FREE'"))).rejects.toMatchObject({ code: '42501' });
    await expect(inTenant(A, () => t.pool.query("UPDATE tenants SET plan = 'BUSINESS'"))).rejects.toMatchObject({ code: '42501' });
  });
});
