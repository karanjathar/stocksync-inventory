import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';

let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let staff: string;
let viewer: string;
let supplierId: string;

beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff');
  viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  supplierId = (await request(t.app).post('/api/suppliers').set(auth(staff)).send({ name: 'Acme Wholesale' })).body.id;
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const qty = async (productId: string, warehouseId: string) => {
  const r = await t.pool.query<{ quantity: number }>('SELECT quantity FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [productId, warehouseId]);
  return r.rows[0]?.quantity ?? 0;
};
/** A SENT purchase order for 10 T-shirts and 4 mugs. */
async function sentPo() {
  const po = (await request(t.app).post('/api/purchase-orders').set(auth(staff)).send({
    supplierId, warehouseId: ids.main.id,
    items: [{ productId: ids.tee.id, quantity: 10, unitCostCents: 900 }, { productId: ids.mug.id, quantity: 4, unitCostCents: 300 }],
  })).body;
  await request(t.app).post(`/api/purchase-orders/${po.id}/send`).set(auth(staff)).send({});
  return po as { id: string; number: number; items: { id: string; productId: string }[] };
}
const itemOf = (po: { items: { id: string; productId: string }[] }, productId: string) => po.items.find((i) => i.productId === productId)!.id;
const receive = (id: string, lines: unknown[], tok = staff) => request(t.app).post(`/api/purchase-orders/${id}/receive`).set(auth(tok)).send({ lines });

describe('receiving against a purchase order (T60)', () => {
  it('books a full receipt through the stock ledger and closes the order', async () => {
    const po = await sentPo();
    const res = await receive(po.id, [{ itemId: itemOf(po, ids.tee.id), quantity: 10 }, { itemId: itemOf(po, ids.mug.id), quantity: 4 }]);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RECEIVED');
    expect(res.body.items.map((i: { receivedQuantity: number }) => i.receivedQuantity).sort((a: number, b: number) => a - b)).toEqual([4, 10]);
    expect(await qty(ids.tee.id, ids.main.id)).toBe(10);
    expect(await qty(ids.mug.id, ids.main.id)).toBe(4);
    const ledger = await t.pool.query('SELECT type, quantity_delta, reference FROM stock_movements WHERE reference = $1 ORDER BY quantity_delta', [`PO-${po.number}`]);
    expect(ledger.rows).toEqual([
      { type: 'IN', quantity_delta: 4, reference: `PO-${po.number}` },
      { type: 'IN', quantity_delta: 10, reference: `PO-${po.number}` },
    ]);
  });

  it('supports partial receipts: PARTIALLY_RECEIVED, then RECEIVED when the rest arrives', async () => {
    const po = await sentPo();
    const first = await receive(po.id, [{ itemId: itemOf(po, ids.tee.id), quantity: 4 }]);
    expect(first.body.status).toBe('PARTIALLY_RECEIVED');
    const second = await receive(po.id, [{ itemId: itemOf(po, ids.tee.id), quantity: 6 }]);
    expect(second.body.status).toBe('PARTIALLY_RECEIVED'); // mugs still outstanding
    const third = await receive(po.id, [{ itemId: itemOf(po, ids.mug.id), quantity: 4 }]);
    expect(third.body.status).toBe('RECEIVED');
  });

  it('never receives more than was ordered, and a bad line changes nothing (all or nothing)', async () => {
    const po = await sentPo();
    const teeBefore = await qty(ids.tee.id, ids.main.id);
    const over = await receive(po.id, [{ itemId: itemOf(po, ids.tee.id), quantity: 5 }, { itemId: itemOf(po, ids.mug.id), quantity: 5 }]);
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/only 4 still expected/);
    expect(await qty(ids.tee.id, ids.main.id)).toBe(teeBefore);
    const state = await request(t.app).get(`/api/purchase-orders/${po.id}`).set(auth(staff));
    expect(state.body.status).toBe('SENT');
    expect(state.body.items.every((i: { receivedQuantity: number }) => i.receivedQuantity === 0)).toBe(true);
  });

  it('only SENT or partially received orders can be received', async () => {
    const draft = (await request(t.app).post('/api/purchase-orders').set(auth(staff)).send({
      supplierId, warehouseId: ids.main.id, items: [{ productId: ids.tee.id, quantity: 1, unitCostCents: 1 }] })).body;
    expect((await receive(draft.id, [{ itemId: draft.items[0].id, quantity: 1 }])).status).toBe(409);
    const cancelled = await sentPo();
    await request(t.app).post(`/api/purchase-orders/${cancelled.id}/cancel`).set(auth(staff)).send({});
    expect((await receive(cancelled.id, [{ itemId: cancelled.items[0]!.id, quantity: 1 }])).status).toBe(409);
    const done = await sentPo();
    await receive(done.id, [{ itemId: itemOf(done, ids.tee.id), quantity: 10 }, { itemId: itemOf(done, ids.mug.id), quantity: 4 }]);
    expect((await receive(done.id, [{ itemId: itemOf(done, ids.tee.id), quantity: 1 }])).status).toBe(409);
  });

  it('can receive a line into another warehouse', async () => {
    const po = await sentPo();
    const before = await qty(ids.tee.id, ids.shop.id);
    const res = await receive(po.id, [{ itemId: itemOf(po, ids.tee.id), quantity: 3, warehouseId: ids.shop.id }]);
    expect(res.status).toBe(200);
    expect(await qty(ids.tee.id, ids.shop.id)).toBe(before + 3);
    expect((await receive(po.id, [{ itemId: itemOf(po, ids.tee.id), quantity: 1, warehouseId: '00000000-0000-4000-8000-000000000000' }])).status).toBe(404);
  });

  it('rejects malformed lines', async () => {
    const po = await sentPo();
    const tee = itemOf(po, ids.tee.id);
    expect((await receive(po.id, [])).status).toBe(400);
    expect((await receive(po.id, [{ itemId: tee, quantity: 0 }])).status).toBe(400);
    expect((await receive(po.id, [{ itemId: tee, quantity: -2 }])).status).toBe(400);
    expect((await receive(po.id, [{ itemId: tee, quantity: 1 }, { itemId: tee, quantity: 1 }])).status).toBe(400);
    expect((await receive(po.id, [{ itemId: '00000000-0000-4000-8000-000000000000', quantity: 1 }])).status).toBe(404);
    const other = await sentPo(); // an item id from a different order must not work here
    expect((await receive(po.id, [{ itemId: itemOf(other, ids.tee.id), quantity: 1 }])).status).toBe(404);
    expect((await receive('00000000-0000-4000-8000-000000000000', [{ itemId: tee, quantity: 1 }])).status).toBe(404);
  });

  it('is safe under concurrent double-submit: stock rises exactly once', async () => {
    const po = await sentPo();
    const before = await qty(ids.tee.id, ids.main.id);
    const lines = [{ itemId: itemOf(po, ids.tee.id), quantity: 10 }];
    const results = await Promise.all(Array.from({ length: 6 }, () => receive(po.id, lines)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await qty(ids.tee.id, ids.main.id)).toBe(before + 10);
  });

  it('is staff-only', async () => {
    const po = await sentPo();
    const lines = [{ itemId: itemOf(po, ids.tee.id), quantity: 1 }];
    expect((await receive(po.id, lines, viewer)).status).toBe(403);
    expect((await request(t.app).post(`/api/purchase-orders/${po.id}/receive`).send({ lines })).status).toBe(401);
  });

  it('a partly received order can no longer be cancelled, and the stock event fires', async () => {
    const events: string[] = [];
    t.c.events.subscribe((e) => { if (e.type === 'stock.changed') events.push(e.sku); });
    const po = await sentPo();
    await receive(po.id, [{ itemId: itemOf(po, ids.mug.id), quantity: 1 }]);
    expect(events).toContain('MUG');
    expect((await request(t.app).post(`/api/purchase-orders/${po.id}/cancel`).set(auth(staff)).send({})).status).toBe(409);
  });
});
