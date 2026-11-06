import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;
let staff: string;
let viewer: string;
let main: string;
let acme: string;
let globex: string;

beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff');
  viewer = await t.token('viewer');
  main = (await post('/api/warehouses', { code: 'MAIN', name: 'Main' })).body.id;
  acme = (await post('/api/suppliers', { name: 'Acme' })).body.id;
  globex = (await post('/api/suppliers', { name: 'Globex' })).body.id;
  await t.c.settings.update({ defaultWarehouseId: main });
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
function post(url: string, body: unknown, tok = staff) { return request(t.app).post(url).set(auth(tok)).send(body as object); }
const get = (url: string, tok = staff) => request(t.app).get(url).set(auth(tok));
let n = 0;
/** A product with the given reorder settings and on-hand stock. */
async function product(o: { level: number; onHand: number; reorderQuantity?: number; supplierId?: string | null; active?: boolean }) {
  const sku = `R${++n}`;
  const p = (await post('/api/products', {
    sku, name: `Item ${sku}`, priceCents: 1000, reorderLevel: o.level,
    ...(o.reorderQuantity !== undefined ? { reorderQuantity: o.reorderQuantity } : {}),
    ...(o.supplierId !== undefined ? { preferredSupplierId: o.supplierId } : {}),
    ...(o.active === false ? { isActive: false } : {}),
  })).body as { id: string; sku: string };
  if (o.onHand) await t.c.stock.receive({ productId: p.id, warehouseId: main, quantity: o.onHand }, null);
  return p;
}
const suggestions = async () => (await get('/api/reorder-suggestions')).body as { productId: string; sku: string; suggestedQuantity: number; supplierId: string | null; onHand: number; incoming: number; lastCostCents: number }[];
const find = async (id: string) => (await suggestions()).find((s) => s.productId === id);

describe('reorder settings on products (T62)', () => {
  it('stores a reorder quantity and a preferred supplier', async () => {
    const p = await product({ level: 5, onHand: 1, reorderQuantity: 20, supplierId: acme });
    const read = (await get(`/api/products/${p.id}`)).body;
    expect(read).toMatchObject({ reorderQuantity: 20, preferredSupplierId: acme });
    const patched = await request(t.app).patch(`/api/products/${p.id}`).set(auth(staff)).send({ preferredSupplierId: null, reorderQuantity: 0 });
    expect(patched.body).toMatchObject({ reorderQuantity: 0, preferredSupplierId: null });
    expect((await request(t.app).patch(`/api/products/${p.id}`).set(auth(staff)).send({ reorderQuantity: -1 })).status).toBe(400);
    expect((await request(t.app).patch(`/api/products/${p.id}`).set(auth(staff)).send({ preferredSupplierId: '00000000-0000-4000-8000-000000000000' })).status).toBe(409);
  });

  it('defaults for existing products are 0 and no supplier', async () => {
    const p = await product({ level: 0, onHand: 0 });
    expect((await get(`/api/products/${p.id}`)).body).toMatchObject({ reorderQuantity: 0, preferredSupplierId: null });
  });
});

describe('reorder suggestions (T62)', () => {
  it('lists active tracked products at or below their reorder level, with a suggested quantity', async () => {
    const low = await product({ level: 10, onHand: 4, reorderQuantity: 50, supplierId: acme });
    const atLevel = await product({ level: 10, onHand: 10, supplierId: acme });
    const fine = await product({ level: 10, onHand: 11, supplierId: acme });
    const untracked = await product({ level: 0, onHand: 0, supplierId: acme });
    const inactive = await product({ level: 10, onHand: 0, supplierId: acme, active: false });
    const rows = await suggestions();
    const ids = rows.map((r) => r.productId);
    expect(ids).toContain(low.id);
    expect(ids).toContain(atLevel.id);
    for (const p of [fine, untracked, inactive]) expect(ids).not.toContain(p.id);
    expect(await find(low.id)).toMatchObject({ suggestedQuantity: 50, supplierId: acme, onHand: 4, incoming: 0 });
    // no reorder quantity set: refill to twice the level, at least 1
    expect((await find(atLevel.id))!.suggestedQuantity).toBe(10);
    const empty = await product({ level: 6, onHand: 0 });
    expect((await find(empty.id))!.suggestedQuantity).toBe(12);
  });

  it('counts goods already on order (draft, sent, partly received) so nothing is ordered twice', async () => {
    const p = await product({ level: 10, onHand: 2, reorderQuantity: 30, supplierId: acme });
    expect(await find(p.id)).toBeDefined();
    const po = (await post('/api/purchase-orders', { supplierId: acme, warehouseId: main, items: [{ productId: p.id, quantity: 20, unitCostCents: 700 }] })).body;
    expect(await find(p.id)).toBeUndefined(); // 2 + 20 incoming > level 10
    await post(`/api/purchase-orders/${po.id}/cancel`, {});
    expect(await find(p.id)).toBeDefined(); // cancelled orders do not count
  });

  it('still suggests the shortfall when incoming goods do not cover the level', async () => {
    const p = await product({ level: 10, onHand: 0, supplierId: acme });
    await post('/api/purchase-orders', { supplierId: acme, warehouseId: main, items: [{ productId: p.id, quantity: 3, unitCostCents: 500 }] });
    expect(await find(p.id)).toMatchObject({ onHand: 0, incoming: 3, suggestedQuantity: 17 }); // 2 x 10 - 3
  });

  it('suggests the most recent purchase cost', async () => {
    const p = await product({ level: 10, onHand: 0, reorderQuantity: 5, supplierId: acme });
    const po = (await post('/api/purchase-orders', { supplierId: acme, warehouseId: main, items: [{ productId: p.id, quantity: 5, unitCostCents: 640 }] })).body;
    await post(`/api/purchase-orders/${po.id}/cancel`, {});
    expect((await find(p.id))!.lastCostCents).toBe(640);
  });
});

describe('creating draft purchase orders from suggestions (T62)', () => {
  it('creates one DRAFT PO per preferred supplier with suggested quantities', async () => {
    const a1 = await product({ level: 10, onHand: 1, reorderQuantity: 25, supplierId: acme });
    const a2 = await product({ level: 4, onHand: 0, supplierId: acme });
    const g1 = await product({ level: 8, onHand: 2, reorderQuantity: 40, supplierId: globex });
    const res = await post('/api/reorder-suggestions', { productIds: [a1.id, a2.id, g1.id] });
    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.skipped).toEqual([]);
    const forAcme = res.body.orders.find((o: { supplierId: string }) => o.supplierId === acme);
    const forGlobex = res.body.orders.find((o: { supplierId: string }) => o.supplierId === globex);
    expect(forAcme).toMatchObject({ status: 'DRAFT', warehouseId: main });
    expect(forAcme.items.map((i: { quantity: number }) => i.quantity).sort((a: number, b: number) => a - b)).toEqual([8, 25]);
    expect(forGlobex.items).toHaveLength(1);
    expect(forGlobex.items[0]).toMatchObject({ productId: g1.id, quantity: 40 });
    // creating them removes the items from the suggestion list
    expect(await find(a1.id)).toBeUndefined();
    expect((await post('/api/reorder-suggestions', { productIds: [a1.id] })).status).toBe(409);
  });

  it('skips products without a supplier, not low, or unknown, and says why', async () => {
    const noSupplier = await product({ level: 10, onHand: 0 });
    const fine = await product({ level: 10, onHand: 50, supplierId: acme });
    const ok = await product({ level: 10, onHand: 0, supplierId: acme });
    const res = await post('/api/reorder-suggestions', { productIds: [noSupplier.id, fine.id, ok.id, '00000000-0000-4000-8000-000000000000'] });
    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(1);
    const reasons = Object.fromEntries(res.body.skipped.map((s: { productId: string; reason: string }) => [s.productId, s.reason]));
    expect(reasons[noSupplier.id]).toMatch(/no preferred supplier/i);
    expect(reasons[fine.id]).toMatch(/not below/i);
    expect(reasons['00000000-0000-4000-8000-000000000000']).toMatch(/not found|not below/i);
  });

  it('uses the supplied warehouse, else the default, else asks for one', async () => {
    const other = (await post('/api/warehouses', { code: 'OTH', name: 'Other' })).body.id;
    const p = await product({ level: 10, onHand: 0, supplierId: acme });
    const res = await post('/api/reorder-suggestions', { productIds: [p.id], warehouseId: other });
    expect(res.body.orders[0].warehouseId).toBe(other);
    await t.c.settings.update({ defaultWarehouseId: null });
    const q = await product({ level: 10, onHand: 0, supplierId: acme });
    expect((await post('/api/reorder-suggestions', { productIds: [q.id] })).status).toBe(400);
    await t.c.settings.update({ defaultWarehouseId: main });
  });

  it('is safe against a concurrent double-click: one set of drafts per product', async () => {
    const p = await product({ level: 10, onHand: 0, supplierId: acme });
    const results = await Promise.all(Array.from({ length: 5 }, () => post('/api/reorder-suggestions', { productIds: [p.id] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const open = await t.pool.query("SELECT count(*)::int AS n FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.purchase_order_id WHERE i.product_id = $1 AND o.status = 'DRAFT'", [p.id]);
    expect(open.rows[0].n).toBe(1);
  });

  it('validates input and permissions', async () => {
    expect((await post('/api/reorder-suggestions', { productIds: [] })).status).toBe(400);
    expect((await post('/api/reorder-suggestions', { productIds: ['nope'] })).status).toBe(400);
    expect((await post('/api/reorder-suggestions', { productIds: ['00000000-0000-4000-8000-000000000000'] }, viewer)).status).toBe(403);
    expect((await get('/api/reorder-suggestions', viewer)).status).toBe(200);
    expect((await request(t.app).get('/api/reorder-suggestions')).status).toBe(401);
  });
});
