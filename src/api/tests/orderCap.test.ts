import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { MAX_OPEN_ORDERS } from '../src/services/orders.js';

let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
beforeAll(async () => {
  t = await buildTestApp();
  ids = await seedCatalog(t, await t.token('staff'));
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 1000 }, null);
  await t.c.settings.update({ defaultWarehouseId: ids.main.id });
});
afterAll(async () => { await t.close(); });

const tap = (from: string, action: string) => t.c.bot.handle({ channel: 'whatsapp', from, text: action, action, senderName: 'Cap Tester' });
const orderViaTaps = async (from: string) => { await tap(from, `qty:${ids.tee.id}:1`); return tap(from, 'pay:cod'); };
const customerOf = async (from: string) => (await t.c.customers.findOrCreateByChannel('whatsapp', from, 'Cap Tester')).id;
const open = async (from: string) => (await t.c.orders.list({ customerId: await customerOf(from), status: 'PENDING', limit: 500 })).length;

describe('open-order cap (T57)', () => {
  it('the limit is 15', () => { expect(MAX_OPEN_ORDERS).toBe(15); });

  it('chat taps: the 16th open order is refused with a clear message and the cart is kept', async () => {
    const who = '919900000001';
    for (let i = 0; i < MAX_OPEN_ORDERS; i++) expect((await orderViaTaps(who)).text).toMatch(/placed/i);
    const blocked = await orderViaTaps(who);
    expect(blocked.text).toMatch(/too many open orders \(15\)/i);
    expect(await open(who)).toBe(15);
    expect((await tap(who, 'cart')).text).toContain('1 × T-Shirt'); // nothing lost: the shopper can retry after some are handled
  });

  it('the typed "order" command is capped too', async () => {
    const who = '919900000001';
    const reply = await t.c.bot.handle({ channel: 'whatsapp', from: who, text: 'order TEE 1', senderName: 'Cap Tester' });
    expect(reply.text).toMatch(/too many open orders/i);
    expect(await open(who)).toBe(15);
  });

  it('handled orders free their slot (confirmed, fulfilled or cancelled)', async () => {
    const who = '919900000001';
    const [first, second] = (await t.c.orders.list({ customerId: await customerOf(who), status: 'PENDING', limit: 5 }));
    await t.c.orders.confirm(first!.id, undefined, null);
    await t.c.orders.cancel(second!.id, null);
    expect(await open(who)).toBe(13);
    expect((await tap(who, 'pay:cod')).text).toMatch(/placed/i); // the kept cart goes through now
    expect(await open(who)).toBe(14);
  });

  it('other customers are unaffected', async () => {
    expect((await orderViaTaps('919900000002')).text).toMatch(/placed/i);
  });

  it('the website is capped per shopper (phone), with HTTP 429', async () => {
    const place = (phone: string) => request(t.app).post('/api/public/orders').send({ name: 'Web', phone, items: [{ productId: ids.tee.id, quantity: 1 }] });
    for (let i = 0; i < MAX_OPEN_ORDERS; i++) expect((await place('+919900000003')).status).toBe(201);
    const blocked = await place('+919900000003');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({ code: 'TOO_MANY_OPEN_ORDERS' });
    expect((await place('+919900000004')).status).toBe(201);
  });

  it('staff-entered (manual) orders are never capped', async () => {
    const customerId = (await t.c.customers.findOrCreateByChannel('web', '919900000005', 'Wholesale Buyer')).id;
    for (let i = 0; i < MAX_OPEN_ORDERS + 3; i++) {
      await t.c.orders.create({ customerId, channel: 'manual', items: [{ productId: ids.tee.id, quantity: 1 }] });
    }
    expect((await t.c.orders.list({ customerId, status: 'PENDING', limit: 500 })).length).toBe(MAX_OPEN_ORDERS + 3);
  });

  it('holds under concurrency: 30 simultaneous requests create exactly 15 orders', async () => {
    const customerId = (await t.c.customers.findOrCreateByChannel('whatsapp', '919900000006', 'Racer')).id;
    const results = await Promise.allSettled(Array.from({ length: 30 }, () =>
      t.c.orders.create({ customerId, channel: 'whatsapp', items: [{ productId: ids.tee.id, quantity: 1 }] })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_OPEN_ORDERS);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 429)).toHaveLength(30 - MAX_OPEN_ORDERS);
    expect((await t.c.orders.list({ customerId, status: 'PENDING', limit: 500 })).length).toBe(MAX_OPEN_ORDERS);
  });
});
