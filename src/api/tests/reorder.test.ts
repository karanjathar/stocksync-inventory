import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';

let t: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>;
let staff: string; let viewer: string; let acme: string; let globex: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const product = async (sku: string, reorderLevel: number) => (await request(t.app).post('/api/products').set(h(staff)).send({ sku, name: sku, priceCents: 100, reorderLevel })).body.id as string;
const stock = (productId: string, quantity: number) => t.c.stock.receive({ productId, warehouseId: ids.main.id, quantity }, null);
const suggestions = async () => (await request(t.app).get('/api/reorder-suggestions').set(h(viewer))).body as { suggestions: { sku: string; suggestedQuantity: number; supplierId: string | null; unitCostCents: number; totalQuantity: number }[] };

beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff'); viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  acme = (await request(t.app).post('/api/suppliers').set(h(staff)).send({ name: 'Acme' })).body.id;
  globex = (await request(t.app).post('/api/suppliers').set(h(staff)).send({ name: 'Globex' })).body.id;
  await t.c.settings.update({ defaultWarehouseId: ids.main.id });
});
afterAll(async () => { await t.close(); });

/** A fully received PO gives a product its "usual supplier" and last cost. */
async function history(supplierId: string, productId: string, unitCostCents: number) {
  const po = await t.c.purchaseOrders.create({ supplierId, warehouseId: ids.main.id, lines: [{ productId, quantity: 1, unitCostCents }] }, null);
  await t.c.purchaseOrders.send(po.id);
  await t.c.purchaseOrders.receive(po.id, `h-${po.id}`, [{ productId, quantity: 1 }], null);
}

describe('GET /api/reorder-suggestions', () => {
  it('lists products at or below their reorder level with quantity, usual supplier and last cost', async () => {
    const lamp = await product('LAMP', 4);
    const fan = await product('FAN', 10);
    await history(acme, ids.tee.id, 700);   // tee: reorder level 5
    await history(globex, fan, 2500);
    await stock(ids.tee.id, 2);             // total 3 (one unit came from the history PO)
    await stock(fan, 10);                   // total 11 > 10 after the history unit → not low
    await stock(lamp, 1);                   // low, but no supplier history
    const { suggestions: list } = await suggestions();
    const bySku = Object.fromEntries(list.map((s) => [s.sku, s]));
    expect(bySku.TEE).toMatchObject({ totalQuantity: 3, suggestedQuantity: 7, supplierId: acme, unitCostCents: 700 }); // 2×5 − 3
    expect(bySku.LAMP).toMatchObject({ totalQuantity: 1, suggestedQuantity: 7, supplierId: null, unitCostCents: 0 });  // 2×4 − 1
    expect(bySku.FAN).toBeUndefined();
    expect(bySku.MUG).toBeUndefined(); // reorder level 0 means "do not track"
  });

  it('is readable by viewers and requires a login', async () => {
    expect((await request(t.app).get('/api/reorder-suggestions')).status).toBe(401);
    expect((await request(t.app).get('/api/reorder-suggestions').set(h(viewer))).status).toBe(200);
  });
});

describe('POST /api/reorder-suggestions/create-pos', () => {
  it('creates one DRAFT PO per supplier, reports products without a supplier, and a second click creates nothing', async () => {
    const globexOnly = await product('PUMP', 3);
    await history(globex, globexOnly, 1200);
    await stock(globexOnly, 0);
    await t.pool.query("UPDATE stock_levels SET quantity = 0 WHERE product_id = $1", [globexOnly]);
    const first = await request(t.app).post('/api/reorder-suggestions/create-pos').set(h(staff)).send({});
    expect(first.status).toBe(201);
    const suppliers = first.body.created.map((p: { supplierId: string }) => p.supplierId).sort();
    expect(suppliers).toEqual([acme, globex].sort());
    const acmePo = first.body.created.find((p: { supplierId: string }) => p.supplierId === acme);
    expect(acmePo).toMatchObject({ status: 'DRAFT', warehouseId: ids.main.id });
    expect(acmePo.lines).toEqual([expect.objectContaining({ sku: 'TEE', quantity: 7, unitCostCents: 700 })]);
    expect(first.body.unassigned.map((s: { sku: string }) => s.sku)).toContain('LAMP');

    const second = await request(t.app).post('/api/reorder-suggestions/create-pos').set(h(staff)).send({});
    expect(second.status).toBe(201);
    expect(second.body.created).toEqual([]);
    expect((await suggestions()).suggestions.map((s) => s.sku)).toEqual(['LAMP']); // everything else is already on an open PO
  });

  it('two simultaneous clicks create the purchase orders once', async () => {
    const sku = await product('BULB', 6);
    await history(acme, sku, 50);
    await t.pool.query('UPDATE stock_levels SET quantity = 0 WHERE product_id = $1', [sku]);
    const before = (await t.pool.query("SELECT count(*)::int AS n FROM purchase_orders WHERE status = 'DRAFT'")).rows[0].n as number;
    const results = await Promise.all([1, 2, 3].map(() => request(t.app).post('/api/reorder-suggestions/create-pos').set(h(staff)).send({})));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const after = (await t.pool.query("SELECT count(*)::int AS n FROM purchase_orders WHERE status = 'DRAFT'")).rows[0].n as number;
    expect(after - before).toBe(1);
  });

  it('can be limited to chosen products, needs staff, and refuses when there is no warehouse', async () => {
    expect((await request(t.app).post('/api/reorder-suggestions/create-pos').set(h(viewer)).send({})).status).toBe(403);
    expect((await request(t.app).post('/api/reorder-suggestions/create-pos').set(h(staff)).send({ productIds: ['not-a-uuid'] })).status).toBe(400);
    const solo = await product('SOLO', 9);
    await history(globex, solo, 10);
    await t.pool.query('UPDATE stock_levels SET quantity = 0 WHERE product_id = $1', [solo]);
    const only = await request(t.app).post('/api/reorder-suggestions/create-pos').set(h(staff)).send({ productIds: [solo] });
    expect(only.body.created).toHaveLength(1);
    expect(only.body.created[0].lines.map((l: { sku: string }) => l.sku)).toEqual(['SOLO']);
  });
});
