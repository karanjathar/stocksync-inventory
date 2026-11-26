import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';

let t: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>; let staff: string; let viewer: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff'); viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
});
afterAll(async () => { await t.close(); });

const open = async (warehouseId = ids.main.id) => (await request(t.app).post('/api/stock-counts').set(h(staff)).send({ warehouseId })).body as { id: string; number: number; status: string };
const setLines = (id: string, lines: { productId: string; countedQuantity: number }[], tok = staff) => request(t.app).put(`/api/stock-counts/${id}/lines`).set(h(tok)).send({ lines });
const submit = (id: string, tok = staff) => request(t.app).post(`/api/stock-counts/${id}/submit`).set(h(tok)).send({});
const qty = async (productId: string, warehouseId = ids.main.id) => Number((await t.pool.query('SELECT COALESCE(sum(quantity), 0) AS q FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [productId, warehouseId])).rows[0].q);
const moves = async (reference: string) => (await t.pool.query('SELECT type, quantity_delta, balance_after, reason FROM stock_movements WHERE reference = $1 ORDER BY quantity_delta', [reference])).rows;

describe('opening and filling a count', () => {
  it('opens a session for a warehouse and shows live system quantities and variance while counting', async () => {
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 10 }, null);
    const c = await open();
    expect(c).toMatchObject({ status: 'OPEN' });
    expect((await setLines(c.id, [{ productId: ids.tee.id, countedQuantity: 7 }])).status).toBe(200);
    const got = await request(t.app).get(`/api/stock-counts/${c.id}`).set(h(viewer));
    expect(got.body.lines).toEqual([expect.objectContaining({ sku: 'TEE', countedQuantity: 7, systemQuantity: 10, variance: -3 })]);
    expect(await qty(ids.tee.id)).toBe(10); // nothing moves until the count is submitted
  });

  it('setting a line again replaces it (safe to resend, which offline sync needs)', async () => {
    const c = await open();
    await setLines(c.id, [{ productId: ids.mug.id, countedQuantity: 2 }]);
    await setLines(c.id, [{ productId: ids.mug.id, countedQuantity: 9 }, { productId: ids.tee.id, countedQuantity: 1 }]);
    const lines = (await request(t.app).get(`/api/stock-counts/${c.id}`).set(h(staff))).body.lines as { sku: string; countedQuantity: number }[];
    expect(lines.map((l) => [l.sku, l.countedQuantity]).sort()).toEqual([['MUG', 9], ['TEE', 1]]);
  });

  it('validates input and permissions', async () => {
    const c = await open();
    expect((await setLines(c.id, [{ productId: ids.tee.id, countedQuantity: -1 }])).status).toBe(400);
    expect((await setLines(c.id, [{ productId: ids.tee.id, countedQuantity: 1.5 }])).status).toBe(400);
    expect((await setLines(c.id, [])).status).toBe(400);
    expect((await setLines(c.id, [{ productId: '00000000-0000-4000-8000-000000000000', countedQuantity: 1 }])).status).toBe(404);
    expect((await request(t.app).post('/api/stock-counts').set(h(staff)).send({ warehouseId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await request(t.app).post('/api/stock-counts').set(h(viewer)).send({ warehouseId: ids.main.id })).status).toBe(403);
    expect((await setLines(c.id, [{ productId: ids.tee.id, countedQuantity: 1 }], viewer)).status).toBe(403);
    expect((await submit(c.id, viewer)).status).toBe(403);
    expect((await request(t.app).get('/api/stock-counts')).status).toBe(401);
  });
});

describe('submitting', () => {
  it('turns variances into ADJUST movements through StockService, leaving uncounted products alone', async () => {
    const w = (await request(t.app).post('/api/warehouses').set(h(staff)).send({ code: 'CNT1', name: 'Count Room' })).body.id as string;
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: w, quantity: 10 }, null);
    await t.c.stock.receive({ productId: ids.mug.id, warehouseId: w, quantity: 5 }, null);
    const bystander = (await request(t.app).post('/api/products').set(h(staff)).send({ sku: 'BYSTANDER', name: 'Not counted', priceCents: 1 })).body.id as string;
    await t.c.stock.receive({ productId: bystander, warehouseId: w, quantity: 3 }, null);
    const c = await open(w);
    await setLines(c.id, [{ productId: ids.tee.id, countedQuantity: 7 }, { productId: ids.mug.id, countedQuantity: 8 }]);
    const res = await submit(c.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUBMITTED');
    expect(await qty(ids.tee.id, w)).toBe(7);
    expect(await qty(ids.mug.id, w)).toBe(8);
    expect(await qty(bystander, w)).toBe(3);
    const ledger = await moves(`COUNT-${c.number}`);
    expect(ledger.map((m) => [m.type, m.quantity_delta])).toEqual([['ADJUST', -3], ['ADJUST', 3]]);
    expect(ledger.every((m) => m.reason === `Stock count #${c.number}`)).toBe(true);
    expect(res.body.lines.map((l: { sku: string; systemQuantity: number; variance: number }) => [l.sku, l.systemQuantity, l.variance]).sort()).toEqual([['MUG', 5, 3], ['TEE', 10, -3]]);
  });

  it('records no movement for an exact match, and can count a product that had no stock row yet', async () => {
    const w = (await request(t.app).post('/api/warehouses').set(h(staff)).send({ code: 'CNT2', name: 'Count Two' })).body.id as string;
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: w, quantity: 4 }, null);
    const c = await open(w);
    await setLines(c.id, [{ productId: ids.tee.id, countedQuantity: 4 }, { productId: ids.mug.id, countedQuantity: 6 }]); // MUG never stocked here
    expect((await submit(c.id)).status).toBe(200);
    expect(await qty(ids.mug.id, w)).toBe(6);
    expect((await moves(`COUNT-${c.number}`)).map((m) => m.quantity_delta)).toEqual([6]);
  });

  it('can only be submitted once, even when clicked concurrently', async () => {
    const w = (await request(t.app).post('/api/warehouses').set(h(staff)).send({ code: 'CNT3', name: 'Count Three' })).body.id as string;
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: w, quantity: 10 }, null);
    const c = await open(w);
    await setLines(c.id, [{ productId: ids.tee.id, countedQuantity: 2 }]);
    const codes = (await Promise.all([submit(c.id), submit(c.id), submit(c.id)])).map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409]);
    expect(await qty(ids.tee.id, w)).toBe(2);
    expect(await moves(`COUNT-${c.number}`)).toHaveLength(1);
  });

  it('refuses an empty count, and refuses edits after submit or cancel', async () => {
    const empty = await open();
    expect((await submit(empty.id)).status).toBe(409);
    const done = await open();
    await setLines(done.id, [{ productId: ids.mug.id, countedQuantity: 1 }]);
    await submit(done.id);
    expect((await setLines(done.id, [{ productId: ids.mug.id, countedQuantity: 2 }])).status).toBe(409);
    expect((await request(t.app).post(`/api/stock-counts/${done.id}/cancel`).set(h(staff)).send({})).status).toBe(409);
    const cancelled = await open();
    expect((await request(t.app).post(`/api/stock-counts/${cancelled.id}/cancel`).set(h(staff)).send({})).body.status).toBe('CANCELLED');
    expect((await setLines(cancelled.id, [{ productId: ids.mug.id, countedQuantity: 2 }])).status).toBe(409);
    expect((await submit(cancelled.id)).status).toBe(409);
  });

  it('lists counts newest first', async () => {
    const list = await request(t.app).get('/api/stock-counts').set(h(viewer));
    expect(list.status).toBe(200);
    expect(list.body[0].number).toBeGreaterThan(list.body[list.body.length - 1].number);
    expect(list.body[0]).toHaveProperty('lineCount');
  });
});
