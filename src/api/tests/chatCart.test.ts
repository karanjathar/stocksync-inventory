import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { ChatCartsRepo } from '../src/repositories/chatCarts.js';

let t: TestApp;
let carts: ChatCartsRepo;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let customer: string;
beforeAll(async () => {
  t = await buildTestApp();
  ids = await seedCatalog(t, await t.token('staff')); // TEE 1500, MUG 800
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 5 }, null);
  await t.c.stock.receive({ productId: ids.mug.id, warehouseId: ids.main.id, quantity: 3 }, null);
  carts = new ChatCartsRepo(t.pool);
  customer = (await t.c.customers.findOrCreateByChannel('whatsapp', '15550001', 'Cart Tester')).id;
});
afterAll(async () => { await t.close(); });

describe('ChatCartsRepo (T30)', () => {
  it('starts empty', async () => {
    expect(await carts.get(customer)).toEqual({ lines: [], totalCents: 0, adjusted: false });
  });

  it('adds, accumulates and prices lines from current product data', async () => {
    await carts.add(customer, ids.tee.id, 2);
    const r = await carts.add(customer, ids.tee.id, 1);
    expect(r.added).toBe(1);
    await carts.add(customer, ids.mug.id, 1);
    const cart = await carts.get(customer);
    expect(cart.lines.map((l) => [l.sku, l.quantity, l.unitPriceCents])).toEqual([['TEE', 3, 1500], ['MUG', 1, 800]]);
    expect(cart.totalCents).toBe(3 * 1500 + 800);
  });

  it('caps quantities at available stock', async () => {
    const r = await carts.add(customer, ids.tee.id, 10);
    expect(r).toMatchObject({ added: 2, capped: true });
    expect((await carts.get(customer)).lines.find((l) => l.sku === 'TEE')!.quantity).toBe(5);
  });

  it('refuses unavailable products', async () => {
    await expect(carts.add(customer, '00000000-0000-0000-0000-000000000000', 1)).rejects.toMatchObject({ status: 404 });
    await request(t.app).patch(`/api/products/${ids.mug.id}`).set({ authorization: `Bearer ${await t.token('staff')}` }).send({ isActive: false });
    await expect(carts.add(customer, ids.mug.id, 1)).rejects.toMatchObject({ status: 409 });
  });

  it('drops inactive products and re-caps when stock falls, reporting the adjustment', async () => {
    await t.c.stock.issue({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 3 }, null); // 2 left
    const cart = await carts.get(customer);
    expect(cart.adjusted).toBe(true);
    expect(cart.lines.map((l) => [l.sku, l.quantity])).toEqual([['TEE', 2]]); // MUG inactive → dropped
    expect((await carts.get(customer)).adjusted).toBe(false); // cleanup persisted
  });

  it('sets, removes and clears', async () => {
    await carts.set(customer, ids.tee.id, 1);
    expect((await carts.get(customer)).lines[0]!.quantity).toBe(1);
    await carts.set(customer, ids.tee.id, 0);
    expect((await carts.get(customer)).lines).toEqual([]);
    await carts.add(customer, ids.tee.id, 1);
    await carts.clear(customer);
    expect((await carts.get(customer)).lines).toEqual([]);
  });

  it('is isolated per customer and survives product deletion', async () => {
    const other = (await t.c.customers.findOrCreateByChannel('telegram', '42', 'Other')).id;
    await carts.add(other, ids.tee.id, 1);
    expect((await carts.get(customer)).lines).toEqual([]);
    await request(t.app).delete(`/api/products/${ids.tee.id}`).set({ authorization: `Bearer ${await t.token('staff')}` }).expect(204);
    expect(await carts.get(other)).toEqual({ lines: [], totalCents: 0, adjusted: true });
  });
});
