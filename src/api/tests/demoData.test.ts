import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { addTenant } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';

let t: TestApp; let admin: string; let staff: string; let other: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const get = () => request(t.app).get('/api/onboarding').set(h(admin));
const step = (body: { steps: { id: string; done: boolean }[] }, id: string) => body.steps.find((s) => s.id === id)!;

beforeAll(async () => {
  t = await buildTestApp({ ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') });
  admin = await t.token('admin'); staff = await t.token('staff');
  const b = await addTenant('other-biz', 'Other Biz');
  await runWithTenant(b, () => t.c.auth.createUser({ email: 'admin@other.test', password: 'Password123!', name: 'O', role: 'admin' }));
  other = (await request(t.app).post('/api/auth/login').send({ email: 'admin@other.test', password: 'Password123!' })).body.token;
});
afterAll(async () => { await t.close(); });

describe('onboarding checklist', () => {
  it('starts with the real state of the business and ticks steps as they happen', async () => {
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.body.steps.map((s: { id: string }) => s.id)).toEqual(['profile', 'warehouse', 'product', 'whatsapp', 'gst']);
    expect(first.body).toMatchObject({ dismissed: false, demo: false, complete: false });
    expect(step(first.body, 'gst')).toMatchObject({ done: false, optional: true });
    expect(step(first.body, 'product').done).toBe(false);

    const w = (await request(t.app).post('/api/warehouses').set(h(admin)).send({ code: 'MAIN', name: 'Main' })).body.id;
    await request(t.app).post('/api/products').set(h(admin)).send({ sku: 'REAL1', name: 'Real item', priceCents: 100 });
    await request(t.app).put('/api/settings').set(h(admin)).send({ businessName: 'My Shop', defaultWarehouseId: w });
    const after = await get();
    expect(['profile', 'warehouse', 'product'].map((id) => step(after.body, id).done)).toEqual([true, true, true]);
    expect(after.body.complete).toBe(false); // WhatsApp is still required
  });

  it('can be dismissed and brought back, per business', async () => {
    expect((await request(t.app).post('/api/onboarding/dismiss').set(h(admin)).send({ dismissed: true })).body.dismissed).toBe(true);
    expect((await get()).body.dismissed).toBe(true);
    expect((await request(t.app).get('/api/onboarding').set(h(other))).body.dismissed).toBe(false);
    await request(t.app).post('/api/onboarding/dismiss').set(h(admin)).send({ dismissed: false });
    expect((await get()).body.dismissed).toBe(false);
  });

  it('is for administrators only', async () => {
    expect((await request(t.app).get('/api/onboarding').set(h(staff))).status).toBe(403);
    expect((await request(t.app).post('/api/onboarding/demo').set(h(staff))).status).toBe(403);
    expect((await request(t.app).get('/api/onboarding')).status).toBe(401);
  });
});

describe('demo data', () => {
  it('adds a clearly marked sample catalogue with stock through the ledger, once', async () => {
    const res = await request(t.app).post('/api/onboarding/demo').set(h(admin));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, products: 6 });
    const products = (await request(t.app).get('/api/products').set(h(admin))).body as { sku: string; name: string; totalQuantity: number; priceCents: number }[];
    const demo = products.filter((p) => p.sku.startsWith('DEMO-'));
    expect(demo).toHaveLength(6);
    expect(demo.every((p) => p.name.startsWith('[Demo] ') && Number.isInteger(p.priceCents) && p.totalQuantity > 0)).toBe(true);
    expect((await t.pool.query("SELECT count(*)::int AS n FROM stock_movements WHERE type = 'IN'")).rows[0].n).toBeGreaterThanOrEqual(6); // via StockService, so the ledger agrees
    expect((await get()).body.demo).toBe(true);

    const again = await request(t.app).post('/api/onboarding/demo').set(h(admin));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, products: 6 });
    expect((await request(t.app).get('/api/products').set(h(admin))).body.filter((p: { sku: string }) => p.sku.startsWith('DEMO-'))).toHaveLength(6);
  });

  it('does not count sample products as the business\'s own first product', async () => {
    const fresh = await addTenant('fresh-biz', 'Fresh');
    await runWithTenant(fresh, () => t.c.auth.createUser({ email: 'admin@fresh.test', password: 'Password123!', name: 'F', role: 'admin' }));
    const tok = (await request(t.app).post('/api/auth/login').send({ email: 'admin@fresh.test', password: 'Password123!' })).body.token;
    await request(t.app).post('/api/onboarding/demo').set(h(tok));
    const body = (await request(t.app).get('/api/onboarding').set(h(tok))).body;
    expect(step(body, 'product').done).toBe(false);
    expect(step(body, 'warehouse').done).toBe(false);
  });

  it('is isolated per business', async () => {
    const mine = (await request(t.app).get('/api/products').set(h(other))).body as { sku: string }[];
    expect(mine.filter((p) => p.sku.startsWith('DEMO-'))).toHaveLength(0);
    expect((await request(t.app).delete('/api/onboarding/demo').set(h(other))).body).toMatchObject({ removed: 0, kept: 0 });
    expect((await request(t.app).get('/api/products').set(h(admin))).body.filter((p: { sku: string }) => p.sku.startsWith('DEMO-'))).toHaveLength(6);
  });

  it('removes every sample record, leaves real ones, and can be added again', async () => {
    const removed = await request(t.app).delete('/api/onboarding/demo').set(h(admin));
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ removed: 6, kept: 0 });
    const products = (await request(t.app).get('/api/products').set(h(admin))).body as { sku: string }[];
    expect(products.map((p) => p.sku)).toEqual(['REAL1']);
    expect((await t.pool.query("SELECT count(*)::int AS n FROM warehouses WHERE code = 'DEMO'")).rows[0].n).toBe(0);
    expect((await get()).body.demo).toBe(false);
    expect((await request(t.app).post('/api/onboarding/demo').set(h(admin))).body.created).toBe(true);
  });

  it('keeps (hides) a sample product that already has real orders instead of failing', async () => {
    const list = (await request(t.app).get('/api/products').set(h(admin))).body as { id: string; sku: string }[];
    const demoProduct = list.find((p) => p.sku.startsWith('DEMO-'))!;
    const customer = (await request(t.app).post('/api/customers').set(h(admin)).send({ name: 'Real customer' })).body.id;
    await request(t.app).post('/api/orders').set(h(admin)).send({ customerId: customer, channel: 'manual', items: [{ productId: demoProduct.id, quantity: 1 }] });
    const removed = (await request(t.app).delete('/api/onboarding/demo').set(h(admin))).body;
    expect(removed).toMatchObject({ removed: 5, kept: 1 });
    const left = (await request(t.app).get('/api/products').set(h(admin))).body as { id: string; isActive: boolean }[];
    expect(left.find((p) => p.id === demoProduct.id)?.isActive).toBe(false);
  });
});
