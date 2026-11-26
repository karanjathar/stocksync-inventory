import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';

let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let staff: string; let viewer: string; let supplier: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff'); viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  supplier = (await request(t.app).post('/api/suppliers').set(h(staff)).send({ name: 'Acme Wholesale' })).body.id;
});
afterAll(async () => { await t.close(); });

const body = (over: object = {}) => ({ supplierId: supplier, warehouseId: ids.main.id, lines: [{ productId: ids.tee.id, quantity: 10, unitCostCents: 900 }, { productId: ids.mug.id, quantity: 4, unitCostCents: 300 }], ...over });
const create = async (over: object = {}) => (await request(t.app).post('/api/purchase-orders').set(h(staff)).send(body(over))).body as { id: string; number: number; status: string; totalCents: number };
const sent = async () => { const po = await create(); await request(t.app).post(`/api/purchase-orders/${po.id}/send`).set(h(staff)); return po; };
const receive = (id: string, receiptId: string, lines: { productId: string; quantity: number }[]) =>
  request(t.app).post(`/api/purchase-orders/${id}/receive`).set(h(staff)).send({ receiptId, lines });
const stockOf = async (productId: string) => Number((await t.pool.query('SELECT COALESCE(sum(quantity),0) AS q FROM stock_levels WHERE product_id = $1', [productId])).rows[0].q);

describe('create and edit', () => {
  it('creates a DRAFT with supplier name, line details and a total in cents', async () => {
    const res = await request(t.app).post('/api/purchase-orders').set(h(staff)).send(body({ notes: 'Rush' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'DRAFT', supplierName: 'Acme Wholesale', notes: 'Rush', totalCents: 10 * 900 + 4 * 300 });
    expect(res.body.lines).toEqual(expect.arrayContaining([expect.objectContaining({ sku: 'TEE', quantity: 10, receivedQuantity: 0, unitCostCents: 900 })]));
  });

  it('validates input and permissions', async () => {
    const post = (b: object, tok = staff) => request(t.app).post('/api/purchase-orders').set(h(tok)).send(b);
    expect((await post(body({ lines: [] }))).status).toBe(400);
    expect((await post(body({ lines: [{ productId: ids.tee.id, quantity: 0, unitCostCents: 1 }] }))).status).toBe(400);
    expect((await post(body({ lines: [{ productId: ids.tee.id, quantity: 1, unitCostCents: -1 }] }))).status).toBe(400);
    expect((await post(body({ lines: [{ productId: ids.tee.id, quantity: 1, unitCostCents: 1 }, { productId: ids.tee.id, quantity: 2, unitCostCents: 1 }] }))).status).toBe(400);
    expect((await post(body({ supplierId: '00000000-0000-4000-8000-000000000000' }))).status).toBe(404);
    expect((await post(body({ warehouseId: '00000000-0000-4000-8000-000000000000' }))).status).toBe(404);
    expect((await post(body({ lines: [{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1, unitCostCents: 1 }] }))).status).toBe(404);
    expect((await post(body(), viewer)).status).toBe(403);
    expect((await request(t.app).post('/api/purchase-orders').send(body())).status).toBe(401);
  });

  it('viewers can read; only DRAFT orders can be edited', async () => {
    const po = await create();
    expect((await request(t.app).get(`/api/purchase-orders/${po.id}`).set(h(viewer))).status).toBe(200);
    const edit = await request(t.app).patch(`/api/purchase-orders/${po.id}`).set(h(staff)).send({ notes: 'changed', lines: [{ productId: ids.mug.id, quantity: 2, unitCostCents: 250 }] });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ notes: 'changed', totalCents: 500 });
    expect(edit.body.lines).toHaveLength(1);
    await request(t.app).post(`/api/purchase-orders/${po.id}/send`).set(h(staff));
    expect((await request(t.app).patch(`/api/purchase-orders/${po.id}`).set(h(staff)).send({ notes: 'late' })).status).toBe(409);
    expect((await request(t.app).get('/api/purchase-orders/not-a-uuid').set(h(viewer))).status).toBe(404);
  });

  it('lists with status and supplier filters', async () => {
    const list = await request(t.app).get('/api/purchase-orders?status=DRAFT').set(h(viewer));
    expect(list.status).toBe(200);
    expect(list.body.every((p: { status: string }) => p.status === 'DRAFT')).toBe(true);
    expect((await request(t.app).get(`/api/purchase-orders?supplierId=${supplier}`).set(h(viewer))).body.length).toBeGreaterThan(0);
  });
});

describe('send, receive and cancel', () => {
  it('send moves DRAFT → SENT once', async () => {
    const po = await create();
    expect((await request(t.app).post(`/api/purchase-orders/${po.id}/send`).set(h(staff))).body.status).toBe('SENT');
    expect((await request(t.app).post(`/api/purchase-orders/${po.id}/send`).set(h(staff))).status).toBe(409);
  });

  it('cannot receive against a DRAFT', async () => {
    const po = await create();
    expect((await receive(po.id, 'r1', [{ productId: ids.tee.id, quantity: 1 }])).status).toBe(409);
  });

  it('receives partially then fully, through the stock ledger with the PO reference', async () => {
    const before = await stockOf(ids.tee.id);
    const po = await sent();
    const r1 = await receive(po.id, 'r1', [{ productId: ids.tee.id, quantity: 6 }]);
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('PARTIALLY_RECEIVED');
    expect(await stockOf(ids.tee.id)).toBe(before + 6);
    const r2 = await receive(po.id, 'r2', [{ productId: ids.tee.id, quantity: 4 }, { productId: ids.mug.id, quantity: 4 }]);
    expect(r2.body.status).toBe('RECEIVED');
    expect(r2.body.lines.map((l: { receivedQuantity: number }) => l.receivedQuantity).sort((a: number, b: number) => a - b)).toEqual([4, 10]);
    const moves = await t.pool.query("SELECT type, quantity_delta, reference FROM stock_movements WHERE reference = $1 ORDER BY created_at", [`PO-${po.number}`]);
    expect(moves.rows).toHaveLength(3);
    expect(moves.rows.every((m) => m.type === 'IN')).toBe(true);
  });

  it('a repeated receipt id is a no-op (stock changes once)', async () => {
    const po = await sent();
    const before = await stockOf(ids.tee.id);
    const lines = [{ productId: ids.tee.id, quantity: 3 }];
    expect((await receive(po.id, 'same', lines)).status).toBe(200);
    const again = await receive(po.id, 'same', lines);
    expect(again.status).toBe(200);
    expect(again.body.lines.find((l: { sku: string }) => l.sku === 'TEE').receivedQuantity).toBe(3);
    expect(await stockOf(ids.tee.id)).toBe(before + 3);
  });

  it('refuses over-receiving and unknown lines, changing nothing', async () => {
    const po = await sent();
    const before = await stockOf(ids.mug.id);
    expect((await receive(po.id, 'x1', [{ productId: ids.mug.id, quantity: 5 }])).status).toBe(409); // ordered 4
    expect((await receive(po.id, 'x2', [{ productId: ids.mug.id, quantity: 2 }, { productId: ids.tee.id, quantity: 11 }])).status).toBe(409); // second line too many: nothing applied
    expect(await stockOf(ids.mug.id)).toBe(before);
    const other = (await request(t.app).post('/api/products').set(h(staff)).send({ sku: 'NOT-ON-PO', name: 'Other', priceCents: 1 })).body;
    expect((await receive(po.id, 'x3', [{ productId: other.id, quantity: 1 }])).status).toBe(409);
    // the failed receipt ids were not consumed
    expect((await receive(po.id, 'x1', [{ productId: ids.mug.id, quantity: 4 }])).status).toBe(200);
  });

  it('concurrent receipts can never exceed the ordered quantity', async () => {
    const po = await sent();
    const before = await stockOf(ids.tee.id);
    const results = await Promise.all(['a', 'b', 'c'].map((r) => receive(po.id, r, [{ productId: ids.tee.id, quantity: 6 }])));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await stockOf(ids.tee.id)).toBe(before + 6);
  });

  it('cancel works before any receipt and is refused after one; cancelled orders cannot be received', async () => {
    const fresh = await sent();
    expect((await request(t.app).post(`/api/purchase-orders/${fresh.id}/cancel`).set(h(staff))).body.status).toBe('CANCELLED');
    expect((await receive(fresh.id, 'c1', [{ productId: ids.tee.id, quantity: 1 }])).status).toBe(409);
    const partly = await sent();
    await receive(partly.id, 'p1', [{ productId: ids.tee.id, quantity: 1 }]);
    expect((await request(t.app).post(`/api/purchase-orders/${partly.id}/cancel`).set(h(staff))).status).toBe(409);
    expect((await request(t.app).post(`/api/purchase-orders/${fresh.id}/cancel`).set(h(staff))).status).toBe(409);
  });

  it('viewers cannot send, receive or cancel', async () => {
    const po = await sent();
    for (const path of ['send', 'cancel']) expect((await request(t.app).post(`/api/purchase-orders/${po.id}/${path}`).set(h(viewer))).status).toBe(403);
    expect((await request(t.app).post(`/api/purchase-orders/${po.id}/receive`).set(h(viewer)).send({ receiptId: 'v', lines: [{ productId: ids.tee.id, quantity: 1 }] })).status).toBe(403);
  });
});
