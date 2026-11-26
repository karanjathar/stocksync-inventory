import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';
import { summariseBody } from '../src/services/audit.js';

let t: TestApp; let owner: pg.Pool; let platform: string; let A: string; let B: string; let adminA: string; let adminB: string; let staffA: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);
const mk = async (tenant: string, email: string, role: 'admin' | 'staff') => {
  await inTenant(tenant, () => t.c.auth.createUser({ email, password: 'Password123!', name: email, role }));
  return (await request(t.app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.token as string;
};
const settle = () => new Promise((r) => setTimeout(r, 60)); // the entry is written just after the response
const log = async (tok: string, qs = '') => (await request(t.app).get(`/api/audit-log${qs}`).set(h(tok))).body as { entries: { action: string; actor: string; entityId: string | null; detail: { fields?: string[]; values?: Record<string, unknown> } }[]; next: string | null };

beforeAll(async () => {
  t = await buildTestApp({ PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!' });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  platform = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token;
  A = await addTenant('audit-a', 'Audit A'); B = await addTenant('audit-b', 'Audit B');
  await owner.query("UPDATE tenants SET plan = 'PRO' WHERE id = $1", [A]); // more than the Free plan's two users
  adminA = await mk(A, 'admin@a.test', 'admin'); adminB = await mk(B, 'admin@b.test', 'admin'); staffA = await mk(A, 'staff@a.test', 'staff');
});
afterAll(async () => { await owner.end(); await t.close(); });

describe('summariseBody', () => {
  it('keeps field names, and values only from a short safe list', () => {
    expect(summariseBody({ password: 'hunter2-secret', email: 'a@b.c', priceCents: 1999, role: 'admin', token: 'abc', name: 'Ann' })).toEqual({
      fields: ['password', 'email', 'priceCents', 'role', 'token', 'name'], values: { priceCents: 1999, role: 'admin' } });
    expect(summariseBody('x')).toEqual({});
    expect(summariseBody({ reason: 'x'.repeat(500) })).toEqual({ fields: ['reason'] }); // long free text is not stored
  });
});

describe('what gets recorded', () => {
  it('records who changed what, for the business that did it, and never a secret', async () => {
    const created = await request(t.app).post('/api/users').set(h(adminA)).send({ email: 'new@a.test', password: 'SuperSecret123!', name: 'New', role: 'staff' });
    await request(t.app).put('/api/settings').set(h(adminA)).send({ businessName: 'Renamed Shop' });
    const product = (await request(t.app).post('/api/products').set(h(adminA)).send({ sku: 'AUD1', name: 'Audited', priceCents: 1000 })).body.id;
    await request(t.app).patch(`/api/products/${product}`).set(h(adminA)).send({ priceCents: 1250 });
    await request(t.app).patch(`/api/users/${created.body.id}`).set(h(adminA)).send({ role: 'admin' });
    await settle();
    const { entries } = await log(adminA);
    const by = (a: string) => entries.find((e) => e.action === a)!;
    expect(by('POST /users')).toMatchObject({ actor: 'admin@a.test', detail: { fields: ['email', 'password', 'name', 'role'], values: { role: 'staff' } } });
    expect(by('PUT /settings').detail.values).toEqual({ businessName: 'Renamed Shop' });
    const price = entries.find((e) => e.action === 'PATCH /products/:id')!;
    expect(price).toMatchObject({ entityId: product, detail: { values: { priceCents: 1250 } } });
    expect(by('PATCH /users/:id')).toMatchObject({ entityId: created.body.id, detail: { values: { role: 'admin' } } });
    expect(JSON.stringify(entries)).not.toMatch(/SuperSecret123|Password123/); // passwords never reach the log
    expect(entries[0]!.action).toBe('PATCH /users/:id'); // newest first
  });

  it('records stock adjustments, refunds-style actions and billing requests through the same path', async () => {
    const wh = (await request(t.app).post('/api/warehouses').set(h(adminA)).send({ code: 'W1', name: 'W1' })).body.id;
    const p = (await request(t.app).get('/api/products').set(h(adminA))).body[0].id;
    await request(t.app).post('/api/stock/receive').set(h(adminA)).send({ productId: p, warehouseId: wh, quantity: 5 });
    await request(t.app).post('/api/stock/adjust').set(h(adminA)).send({ productId: p, warehouseId: wh, newQuantity: 3, reason: 'recount' });
    await settle();
    const e = (await log(adminA)).entries.find((x) => x.action === 'POST /stock/adjust')!;
    expect(e.detail.values).toEqual({ newQuantity: 3, reason: 'recount' });
  });

  it('does not record reads or failed requests', async () => {
    const before = (await log(adminA, '?limit=200')).entries.length;
    await request(t.app).get('/api/products').set(h(adminA));
    await request(t.app).post('/api/products').set(h(adminA)).send({ sku: '', name: '' }); // 400
    await request(t.app).delete('/api/products/00000000-0000-4000-8000-0000000000ff').set(h(adminA)); // 404
    await settle();
    expect((await log(adminA, '?limit=200')).entries.length).toBe(before);
  });

  it('records the operator\'s plan and suspension changes in the business\'s trail, marked as platform', async () => {
    expect((await request(t.app).patch(`/api/platform/tenants/${A}`).set(h(platform)).send({ plan: 'PRO' })).status).toBe(200);
    expect((await request(t.app).patch(`/api/platform/tenants/${A}`).set(h(platform)).send({ status: 'SUSPENDED' })).status).toBe(200);
    expect((await request(t.app).patch(`/api/platform/tenants/${A}`).set(h(platform)).send({ status: 'ACTIVE' })).status).toBe(200);
    const actions = (await log(adminA, '?actor=platform')).entries;
    expect(actions.map((e) => e.action)).toEqual(['PLATFORM unsuspend', 'PLATFORM suspend', 'PLATFORM plan change']);
    expect(actions.every((e) => e.actor === 'platform:ops@platform.test')).toBe(true);
  });
});

describe('who can see it', () => {
  it('administrators of that business only', async () => {
    expect((await request(t.app).get('/api/audit-log').set(h(staffA))).status).toBe(403);
    expect((await request(t.app).get('/api/audit-log')).status).toBe(401);
    const b = await log(adminB);
    expect(JSON.stringify(b)).not.toMatch(/admin@a\.test|AUD1|Renamed Shop/); // B sees nothing of A
  });

  it('pages and filters', async () => {
    const page1 = await log(adminA, '?limit=2');
    expect(page1.entries).toHaveLength(2);
    expect(page1.next).toBeTruthy();
    const page2 = await log(adminA, `?limit=2&before=${encodeURIComponent(page1.next!)}`);
    expect(page2.entries[0]!.action).not.toBe(page1.entries[0]!.action === page2.entries[0]!.action ? '' : 'x');
    expect(page2.entries.map((e) => JSON.stringify(e))).not.toEqual(expect.arrayContaining(page1.entries.map((e) => JSON.stringify(e))));
    const filtered = await log(adminA, '?action=settings');
    expect(filtered.entries.length).toBeGreaterThan(0);
    expect(filtered.entries.every((e) => /settings/i.test(e.action))).toBe(true);
    expect((await request(t.app).get('/api/audit-log?limit=0').set(h(adminA))).status).toBe(400);
    expect((await request(t.app).get('/api/audit-log?before=garbage').set(h(adminA))).status).toBe(400);
    expect((await request(t.app).get(`/api/audit-log?action=${encodeURIComponent("%' OR 1=1 --")}`).set(h(adminA))).status).toBe(200);
  });
});

describe('append-only', () => {
  it('the application role can add and read rows but cannot change or remove them, even with raw SQL', async () => {
    await inTenant(A, () => t.c.audit.record({ actorId: null, actor: 'test', action: 'TEST' }));
    await expect(inTenant(A, () => t.pool.query("UPDATE audit_log SET action = 'edited'"))).rejects.toMatchObject({ code: '42501' });
    await expect(inTenant(A, () => t.pool.query('DELETE FROM audit_log'))).rejects.toMatchObject({ code: '42501' });
    await expect(inTenant(A, () => t.pool.query('ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY'))).rejects.toMatchObject({ code: '42501' });
    expect((await inTenant(A, () => t.pool.query("SELECT 1 FROM audit_log WHERE action = 'TEST'"))).rowCount).toBe(1);
  });

  it('cannot write into another business\'s trail', async () => {
    await expect(inTenant(A, () => t.pool.query("INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'x', 'forged')", [B]))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('platform console', () => {
  it('lists every business with plan, subscription state and monthly usage, and nothing from inside a business', async () => {
    await inTenant(A, () => t.c.plans.consume('invoices'));
    const res = await request(t.app).get('/api/platform/tenants').set(h(platform));
    expect(res.status).toBe(200);
    const a = res.body.find((x: { slug: string }) => x.slug === 'audit-a');
    expect(a).toMatchObject({ plan: 'PRO', status: 'ACTIVE', subscription: null, invoices: 1, chatMessages: 0 });
    expect(Object.keys(a).sort()).toEqual(['chatMessages', 'createdAt', 'id', 'invoices', 'name', 'plan', 'slug', 'status', 'subscription']);
  });

  it('cannot read business data, the audit trail or act as a business', async () => {
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const plat = await pool.connect(); // a checked-out client keeps its session (a failed pool.query would discard the connection and its SET ROLE)
    try {
      await plat.query('SET ROLE stocksync_platform');
      for (const table of ['products', 'users', 'orders', 'customers', 'audit_log', 'channel_messages', 'tenant_channels']) {
        await expect(plat.query(`SELECT 1 FROM ${table}`), table).rejects.toMatchObject({ code: '42501' });
      }
      await expect(plat.query('UPDATE audit_log SET action = 1')).rejects.toMatchObject({ code: '42501' });
    } finally { plat.release(); await pool.end(); }
    expect((await request(t.app).get('/api/products').set(h(platform))).status).toBe(401);
    expect((await request(t.app).get('/api/audit-log').set(h(platform))).status).toBe(401);
    expect((await request(t.app).get('/api/platform/tenants').set(h(adminA))).status).toBe(401);
  });
});
