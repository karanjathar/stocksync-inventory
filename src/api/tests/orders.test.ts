import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import type { RealtimeEvent } from '../src/domain/types.js';

let t: TestApp;
let staff: string;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let customerId: string;
const events: RealtimeEvent[] = [];
beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff');
  ids = await seedCatalog(t, staff);
  customerId = (await request(t.app).post('/api/customers').set(auth(staff)).send({ name: 'Buyer' })).body.id;
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 10 }, null);
  await t.c.stock.receive({ productId: ids.mug.id, warehouseId: ids.main.id, quantity: 2 }, null);
  t.c.events.subscribe((e) => events.push(e));
});
afterAll(async () => { await t.close(); });
const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const post = (path: string, body: object = {}) => request(t.app).post(path).set(auth(staff)).send(body);

describe('orders', () => {
  let orderId: string;

  it('creates a PENDING order with price snapshot, merged lines and total', async () => {
    const res = await post('/api/orders', { customerId, items: [{ productId: ids.tee.id, quantity: 2 }, { productId: ids.tee.id, quantity: 1 }, { productId: ids.mug.id, quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING', channel: 'manual', customerName: 'Buyer', totalCents: 3 * 1500 + 800, number: expect.any(Number) });
    expect(res.body).toMatchObject({ paymentMethod: 'COD', paymentStatus: 'UNPAID', publicToken: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.find((i: { sku: string }) => i.sku === 'TEE')).toMatchObject({ quantity: 3, unitPriceCents: 1500, name: 'T-Shirt' });
    orderId = res.body.id;
    expect(events.some((e) => e.type === 'order.created')).toBe(true);
  });

  it('rejects empty orders, unknown products and inactive products', async () => {
    expect((await post('/api/orders', { customerId, items: [] })).status).toBe(400);
    expect((await post('/api/orders', { customerId, items: [{ productId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] })).status).toBe(404);
    await request(t.app).patch(`/api/products/${ids.mug.id}`).set(auth(staff)).send({ isActive: false });
    expect((await post('/api/orders', { customerId, items: [{ productId: ids.mug.id, quantity: 1 }] })).status).toBe(409);
    await request(t.app).patch(`/api/products/${ids.mug.id}`).set(auth(staff)).send({ isActive: true });
  });

  it('requires a warehouse to confirm when no default is set', async () => {
    const res = await post(`/api/orders/${orderId}/confirm`);
    expect(res.status).toBe(400);
  });

  it('confirm deducts stock atomically using the default warehouse', async () => {
    await t.c.settings.update({ defaultWarehouseId: ids.main.id });
    const res = await post(`/api/orders/${orderId}/confirm`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CONFIRMED', warehouseId: ids.main.id });
    const levels = await t.c.stock.levels({ warehouseId: ids.main.id });
    expect(Object.fromEntries(levels.map((l) => [l.sku, l.quantity]))).toEqual({ TEE: 7, MUG: 1 });
    const mv = await t.c.stock.movements({ productId: ids.tee.id, limit: 1 });
    expect(mv[0]).toMatchObject({ type: 'OUT', quantityDelta: -3, reference: `ORDER-${res.body.number}` });
    expect((await post(`/api/orders/${orderId}/confirm`)).status).toBe(409);
  });

  it('confirm fails without side effects when stock is insufficient', async () => {
    const o = (await post('/api/orders', { customerId, items: [{ productId: ids.tee.id, quantity: 1 }, { productId: ids.mug.id, quantity: 5 }] })).body;
    const res = await post(`/api/orders/${o.id}/confirm`, { warehouseId: ids.main.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    const levels = await t.c.stock.levels({ warehouseId: ids.main.id });
    expect(Object.fromEntries(levels.map((l) => [l.sku, l.quantity]))).toEqual({ TEE: 7, MUG: 1 });
    expect((await request(t.app).get(`/api/orders/${o.id}`).set(auth(staff))).body.status).toBe('PENDING');
  });

  it('cancelling a confirmed order restocks; fulfilled orders cannot be cancelled', async () => {
    const o = (await post('/api/orders', { customerId, items: [{ productId: ids.tee.id, quantity: 2 }] })).body;
    await post(`/api/orders/${o.id}/confirm`);
    const cancelled = await post(`/api/orders/${o.id}/cancel`);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await t.c.stock.levels({ productId: ids.tee.id, warehouseId: ids.main.id }))[0]!.quantity).toBe(7);
    expect((await post(`/api/orders/${o.id}/cancel`)).status).toBe(409);

    expect((await post(`/api/orders/${orderId}/fulfill`)).body.status).toBe('FULFILLED');
    expect((await post(`/api/orders/${orderId}/cancel`)).status).toBe(409);
  });

  it('lists and filters by status; looks up by number', async () => {
    const all = await request(t.app).get('/api/orders').set(auth(staff));
    expect(all.body.length).toBe(3);
    const pending = await request(t.app).get('/api/orders?status=PENDING').set(auth(staff));
    expect(pending.body).toHaveLength(1);
    const byNum = await t.c.orders.getByNumber(all.body[0].number);
    expect(byNum?.id).toBe(all.body[0].id);
  });

  it('records the payment method for chat/web orders (T29)', async () => {
    const o = await t.c.orders.create({ customerId, channel: 'web', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 1 }] });
    expect(o).toMatchObject({ paymentMethod: 'ONLINE', paymentStatus: 'UNPAID' });
    expect((await t.c.orders.list({ status: 'PENDING' })).find((x) => x.id === o.id)?.paymentMethod).toBe('ONLINE');
    await t.c.orders.cancel(o.id, null);
  });
});
