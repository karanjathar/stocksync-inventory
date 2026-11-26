import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { addTenant } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';

/** Two businesses on one database use the same SKUs, barcodes, numbers and invoice sequences without noticing each other. */
let t: TestApp; let A: string; let B: string;
const GST = { legalName: 'Shop Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: 'Pune', stateCode: '27', invoicePrefix: 'INV', pricesIncludeTax: true };
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);

async function seed(tenant: string) {
  return inTenant(tenant, async () => {
    const wh = (await t.pool.query<{ id: string }>("INSERT INTO warehouses (code, name) VALUES ('MAIN', 'Main') RETURNING id")).rows[0]!.id;
    const product = await t.c.repos.products.create({ sku: 'SAME', name: 'Same product', priceCents: 11800, barcode: '4006381333931', hsnCode: '610910', gstRateBp: 1800 });
    await t.c.stock.receive({ productId: product.id, warehouseId: wh, quantity: 1000 }, null);
    await t.c.settings.update({ currency: 'INR', defaultWarehouseId: wh, gst: GST });
    return { wh, product };
  });
}
const newOrder = (tenant: string, ctx: { product: { id: string } }, n: number) => inTenant(tenant, async () => {
  const customer = await t.c.customers.findOrCreateByChannel('web', `9100${n}`, `Buyer ${n}`);
  return t.c.orders.create({ customerId: customer.id, channel: 'manual', items: [{ productId: ctx.product.id, quantity: 1 }] });
});

let ctxA: Awaited<ReturnType<typeof seed>>; let ctxB: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => {
  t = await buildTestApp();
  A = await addTenant('shop-a', 'Shop A'); B = await addTenant('shop-b', 'Shop B');
  ctxA = await seed(A); ctxB = await seed(B); // identical SKU, barcode and warehouse code in both businesses
});
afterAll(async () => { await t.close(); });

describe('per-tenant numbering', () => {
  it('orders, purchase orders and stock counts each start at 1 in every business', async () => {
    const oa = await newOrder(A, ctxA, 1); const ob = await newOrder(B, ctxB, 1);
    expect([oa.number, ob.number]).toEqual([1, 1]);
    const [oa2, ob2] = [await newOrder(A, ctxA, 2), await newOrder(B, ctxB, 2)];
    expect([oa2.number, ob2.number]).toEqual([2, 2]);
    const sup = (tenant: string) => inTenant(tenant, async () => (await t.pool.query<{ id: string }>("INSERT INTO suppliers (name) VALUES ('Sup') RETURNING id")).rows[0]!.id);
    const poNumber = async (tenant: string, ctx: typeof ctxA) => inTenant(tenant, async () => (await t.c.purchaseOrders.create({ supplierId: await sup(tenant), warehouseId: ctx.wh, lines: [{ productId: ctx.product.id, quantity: 1, unitCostCents: 1 }] }, null)).number);
    expect([await poNumber(A, ctxA), await poNumber(B, ctxB)]).toEqual([1, 1]);
    const countNumber = (tenant: string, ctx: typeof ctxA) => inTenant(tenant, async () => (await t.c.stockCounts.open(ctx.wh, null)).number);
    expect([await countNumber(A, ctxA), await countNumber(B, ctxB)]).toEqual([1, 1]);
  });
});

describe('per-tenant invoices', () => {
  it('both businesses issue INV/…/000001 and never see each other\'s sequence', async () => {
    const oa = await newOrder(A, ctxA, 10); const ob = await newOrder(B, ctxB, 10);
    await inTenant(A, () => t.c.orders.confirm(oa.id, ctxA.wh, null));
    await inTenant(B, () => t.c.orders.confirm(ob.id, ctxB.wh, null));
    const ia = await inTenant(A, () => t.c.invoices.getByOrder(oa.id));
    const ib = await inTenant(B, () => t.c.invoices.getByOrder(ob.id));
    expect(ia!.number).toBe(ib!.number);                 // the same number in two different businesses
    expect(ia!.number).toMatch(/^INV\/2026-27\/000001$/);
    expect((await inTenant(B, () => t.c.invoices.getByOrder(oa.id)))).toBeUndefined(); // B cannot even find A's invoice by its order id
  });

  it('interleaved confirmations in both businesses give each its own gapless 2..16', async () => {
    const orders = await Promise.all(Array.from({ length: 15 }, async (_, i) => ({ a: await newOrder(A, ctxA, 100 + i), b: await newOrder(B, ctxB, 100 + i) })));
    await Promise.all(orders.flatMap((o) => [inTenant(A, () => t.c.orders.confirm(o.a.id, ctxA.wh, null)), inTenant(B, () => t.c.orders.confirm(o.b.id, ctxB.wh, null))]));
    for (const tenant of [A, B]) {
      const seqs = (await inTenant(tenant, () => t.pool.query<{ seq: number }>('SELECT seq FROM invoices ORDER BY seq'))).rows.map((r) => r.seq);
      expect(seqs, tenant).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    }
  });
});

describe('per-tenant settings, webhook ids and housekeeping records', () => {
  it('settings of one business never show up in another', async () => {
    await inTenant(A, () => t.c.settings.update({ businessName: 'Alpha Traders', alertRecipients: [{ channel: 'telegram', to: 'a-owner' }] }));
    const b = await inTenant(B, () => t.c.settings.get());
    expect(b.businessName).toBe('StockSync');
    expect(b.alertRecipients).toEqual([]);
    expect((await inTenant(A, () => t.c.settings.get())).businessName).toBe('Alpha Traders');
  });

  it('the same provider event id is a replay only within its own business', async () => {
    const claim = (tenant: string) => inTenant(tenant, () => t.pool.query("INSERT INTO webhook_events (provider, event_id) VALUES ('razorpay', 'evt_same') ON CONFLICT DO NOTHING"));
    expect((await claim(A)).rowCount).toBe(1);
    expect((await claim(B)).rowCount).toBe(1);   // not a replay for B
    expect((await claim(A)).rowCount).toBe(0);   // a replay for A
  });

  it('maintenance runs are recorded and read per business', async () => {
    await inTenant(A, () => t.c.maintenance.prune());
    expect((await inTenant(A, () => t.pool.query('SELECT task FROM maintenance_runs'))).rows).toEqual([{ task: 'prune' }]);
    expect((await inTenant(B, () => t.pool.query('SELECT task FROM maintenance_runs'))).rows).toEqual([]);
    await inTenant(B, () => t.c.maintenance.prune());
    expect((await inTenant(B, () => t.pool.query('SELECT task FROM maintenance_runs'))).rows).toEqual([{ task: 'prune' }]);
  });

  it('the same barcode looks up each business\'s own product', async () => {
    const a = await inTenant(A, () => t.c.repos.products.getByBarcode('4006381333931'));
    const b = await inTenant(B, () => t.c.repos.products.getByBarcode('4006381333931'));
    expect(a!.id).toBe(ctxA.product.id);
    expect(b!.id).toBe(ctxB.product.id);
    expect(a!.id).not.toBe(b!.id);
  });
});
