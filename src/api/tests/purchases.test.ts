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
const body = (over: Record<string, unknown> = {}) => ({
  supplierId, warehouseId: ids.main.id, notes: 'first order',
  items: [{ productId: ids.tee.id, quantity: 10, unitCostCents: 900 }, { productId: ids.mug.id, quantity: 4, unitCostCents: 300 }],
  ...over,
});
const create = (over: Record<string, unknown> = {}, tok = staff) => request(t.app).post('/api/purchase-orders').set(auth(tok)).send(body(over));
const act = (id: string, what: 'send' | 'cancel', tok = staff) => request(t.app).post(`/api/purchase-orders/${id}/${what}`).set(auth(tok)).send({});

describe('purchase orders (T59)', () => {
  it('creates a DRAFT with a sequential number and server-computed totals', async () => {
    const a = await create({ totalCents: 1 }); // a client-sent total must be ignored
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: 'DRAFT', supplierId, warehouseId: ids.main.id, totalCents: 10 * 900 + 4 * 300, notes: 'first order' });
    expect(a.body.items).toHaveLength(2);
    expect(a.body.items[0]).toMatchObject({ receivedQuantity: 0 });
    const b = await create();
    expect(b.body.number).toBe(a.body.number + 1);
  });

  it('rejects bad input', async () => {
    expect((await create({ supplierId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await create({ warehouseId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await create({ items: [{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1, unitCostCents: 1 }] })).status).toBe(404);
    expect((await create({ items: [] })).status).toBe(400);
    expect((await create({ items: [{ productId: ids.tee.id, quantity: 0, unitCostCents: 100 }] })).status).toBe(400);
    expect((await create({ items: [{ productId: ids.tee.id, quantity: 1, unitCostCents: -1 }] })).status).toBe(400);
    const dup = await create({ items: [{ productId: ids.tee.id, quantity: 1, unitCostCents: 100 }, { productId: ids.tee.id, quantity: 2, unitCostCents: 100 }] });
    expect(dup.status).toBe(400);
    const huge = await create({ items: [{ productId: ids.tee.id, quantity: 1_000_000, unitCostCents: 1_000_000_000 }] });
    expect(huge.status).toBe(400);
    expect(huge.body.error.message).toMatch(/too large/i);
  });

  it('can be edited only while DRAFT, and totals follow the edit', async () => {
    const po = (await create()).body;
    const edited = await request(t.app).patch(`/api/purchase-orders/${po.id}`).set(auth(staff))
      .send({ notes: 'revised', items: [{ productId: ids.tee.id, quantity: 2, unitCostCents: 1000 }] });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ notes: 'revised', totalCents: 2000 });
    expect(edited.body.items).toHaveLength(1);
    expect((await act(po.id, 'send')).status).toBe(200);
    expect((await request(t.app).patch(`/api/purchase-orders/${po.id}`).set(auth(staff)).send({ notes: 'too late' })).status).toBe(409);
  });

  it('rejects impossible calendar dates instead of failing in the database', async () => {
    for (const expectedDate of ['2024-02-31', '2026-13-01', '2026-04-31', 'tomorrow', '2026-1-5']) {
      expect((await create({ expectedDate })).status).toBe(400);
    }
    const ok = await create({ expectedDate: '2028-02-29' }); // a real leap day
    expect(ok.status).toBe(201);
    expect(ok.body.expectedDate).toBe('2028-02-29');
    const patched = await request(t.app).patch(`/api/purchase-orders/${ok.body.id}`).set(auth(staff)).send({ expectedDate: '2026-02-30' });
    expect(patched.status).toBe(400);
    expect((await request(t.app).patch(`/api/purchase-orders/${ok.body.id}`).set(auth(staff)).send({ expectedDate: null })).body.expectedDate).toBeNull();
  });

  it('moves DRAFT → SENT once, and cancels from DRAFT or SENT once', async () => {
    const po = (await create()).body;
    const sent = await act(po.id, 'send');
    expect(sent.body.status).toBe('SENT');
    expect((await act(po.id, 'send')).status).toBe(409);
    expect((await act(po.id, 'cancel')).body.status).toBe('CANCELLED');
    expect((await act(po.id, 'cancel')).status).toBe(409);
    expect((await act(po.id, 'send')).status).toBe(409);
    const draft = (await create()).body;
    expect((await act(draft.id, 'cancel')).body.status).toBe('CANCELLED');
  });

  it('cannot be cancelled once something was received', async () => {
    const po = (await create()).body;
    await act(po.id, 'send');
    await t.pool.query("UPDATE purchase_order_items SET received_quantity = 1 WHERE purchase_order_id = $1 AND product_id = $2", [po.id, ids.tee.id]);
    await t.pool.query("UPDATE purchase_orders SET status = 'PARTIALLY_RECEIVED' WHERE id = $1", [po.id]);
    expect((await act(po.id, 'cancel')).status).toBe(409);
  });

  it('is safe under concurrent sends: exactly one wins', async () => {
    const po = (await create()).body;
    const results = await Promise.all(Array.from({ length: 6 }, () => act(po.id, 'send')));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
  });

  it('lists with filters and reads one; unknown ids are 404', async () => {
    const po = (await create()).body;
    const all = await request(t.app).get('/api/purchase-orders').set(auth(viewer));
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThan(3);
    expect(all.body[0].number).toBeGreaterThan(all.body[1].number); // newest first
    const drafts = await request(t.app).get('/api/purchase-orders?status=DRAFT').set(auth(viewer));
    expect(drafts.body.every((p: { status: string }) => p.status === 'DRAFT')).toBe(true);
    const bySupplier = await request(t.app).get(`/api/purchase-orders?supplierId=${supplierId}`).set(auth(viewer));
    expect(bySupplier.body.length).toBe(all.body.length);
    expect((await request(t.app).get(`/api/purchase-orders/${po.id}`).set(auth(viewer))).body.id).toBe(po.id);
    expect((await request(t.app).get('/api/purchase-orders/00000000-0000-4000-8000-000000000000').set(auth(viewer))).status).toBe(404);
    expect((await request(t.app).get('/api/purchase-orders/not-a-uuid').set(auth(viewer))).status).toBe(404);
    expect((await request(t.app).get('/api/purchase-orders?status=BOGUS').set(auth(viewer))).status).toBe(400);
  });

  it('viewers are read-only and anonymous callers are refused', async () => {
    const po = (await create()).body;
    expect((await create({}, viewer)).status).toBe(403);
    expect((await act(po.id, 'send', viewer)).status).toBe(403);
    expect((await act(po.id, 'cancel', viewer)).status).toBe(403);
    expect((await request(t.app).patch(`/api/purchase-orders/${po.id}`).set(auth(viewer)).send({ notes: 'x' })).status).toBe(403);
    expect((await request(t.app).get('/api/purchase-orders')).status).toBe(401);
    expect((await request(t.app).post('/api/purchase-orders').send(body())).status).toBe(401);
  });

  it('stores money as integers and never touches stock', async () => {
    const before = await t.pool.query('SELECT coalesce(sum(quantity),0)::int AS n FROM stock_levels');
    const po = (await create()).body;
    await act(po.id, 'send');
    const after = await t.pool.query('SELECT coalesce(sum(quantity),0)::int AS n FROM stock_levels');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(Number.isInteger(po.totalCents)).toBe(true);
  });

  it('the Release 3 purchasing tables and product columns exist (used by later tasks)', async () => {
    const tables = await t.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('bills','bill_payments','purchase_orders','purchase_order_items')");
    expect(tables.rowCount).toBe(4);
    const cols = await t.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name IN ('reorder_quantity','preferred_supplier_id')");
    expect(cols.rowCount).toBe(2);
  });
});
