import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay } from './helpers/fakeRazorpay.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let admin: string;
let staff: string;
let viewer: string;
let gst18: string;
let rz: ReturnType<typeof fakeRazorpay>;

beforeAll(async () => {
  rz = fakeRazorpay();
  t = await buildTestApp(RZP, { fetch: rz.fn });
  admin = await t.token('admin');
  staff = await t.token('staff');
  viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 1000 }, null);
  await t.c.stock.receive({ productId: ids.mug.id, warehouseId: ids.main.id, quantity: 1000 }, null);
  await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id });
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const post = (url: string, body: unknown, tok = staff) => request(t.app).post(url).set(auth(tok)).send(body as object);
const patch = (url: string, body: unknown, tok = staff) => request(t.app).patch(url).set(auth(tok)).send(body as object);
const get = (url: string, tok = staff) => request(t.app).get(url).set(auth(tok));
const webOrder = (items: { productId: string; quantity: number }[], extra: object = {}, phone = '+919800000001') =>
  request(t.app).post('/api/public/orders').send({ name: 'Web Buyer', phone, items, ...extra });
const orderRow = async (id: string) => (await t.pool.query('SELECT total_cents, subtotal_cents, tax_cents, discount_cents FROM orders WHERE id = $1', [id])).rows[0];

describe('tax rates (T64)', () => {
  it('admins manage rates, everyone can read them', async () => {
    const made = await post('/api/tax-rates', { name: 'GST 18%', rateBp: 1800 }, admin);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'GST 18%', rateBp: 1800, active: true });
    gst18 = made.body.id;
    expect((await post('/api/tax-rates', { name: 'GST 18%', rateBp: 1800 }, admin)).status).toBe(409); // duplicate name
    expect((await post('/api/tax-rates', { name: 'Bad', rateBp: 10001 }, admin)).status).toBe(400);
    expect((await post('/api/tax-rates', { name: 'Bad', rateBp: -1 }, admin)).status).toBe(400);
    expect((await post('/api/tax-rates', { name: 'Bad', rateBp: 12.5 }, admin)).status).toBe(400);
    expect((await post('/api/tax-rates', { name: 'Nope', rateBp: 500 }, staff)).status).toBe(403);
    expect((await get('/api/tax-rates', viewer)).body.map((r: { name: string }) => r.name)).toContain('GST 18%');
    expect((await request(t.app).get('/api/tax-rates')).status).toBe(401);
    const renamed = await patch(`/api/tax-rates/${gst18}`, { name: 'GST 18 percent' }, admin);
    expect(renamed.body.name).toBe('GST 18 percent');
    expect((await patch(`/api/tax-rates/${gst18}`, { active: false }, staff)).status).toBe(403);
    expect((await patch('/api/tax-rates/00000000-0000-4000-8000-000000000000', { active: false }, admin)).status).toBe(404);
  });

  it('can be assigned to and cleared from a product', async () => {
    const set = await patch(`/api/products/${ids.tee.id}`, { taxRateId: gst18 });
    expect(set.body.taxRateId).toBe(gst18);
    expect((await patch(`/api/products/${ids.tee.id}`, { taxRateId: '00000000-0000-4000-8000-000000000000' })).status).toBe(409);
    expect((await patch(`/api/products/${ids.mug.id}`, { taxRateId: null })).body.taxRateId).toBeNull();
  });
});

describe('server-side totals (T64)', () => {
  it('adds tax on top (exclusive) and stores subtotal, tax and total on the order', async () => {
    await t.c.settings.update({ pricesIncludeTax: false });
    const res = await webOrder([{ productId: ids.tee.id, quantity: 2 }]);
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(3540); // 2 x 15.00 + 18%
    const row = await orderRow((await t.c.orders.getByNumber(res.body.number))!.id);
    expect(row).toEqual({ total_cents: 3540, subtotal_cents: 3000, tax_cents: 540, discount_cents: 0 });
  });

  it('keeps tax inside the price when prices include tax', async () => {
    await t.c.settings.update({ pricesIncludeTax: true });
    const res = await webOrder([{ productId: ids.tee.id, quantity: 2 }], {}, '+919800000002');
    expect(res.body.totalCents).toBe(3000);
    const row = await orderRow((await t.c.orders.getByNumber(res.body.number))!.id);
    expect(row).toEqual({ total_cents: 3000, subtotal_cents: 2542, tax_cents: 458, discount_cents: 0 }); // 3000 x 1800 / 11800 = 457.6
    await t.c.settings.update({ pricesIncludeTax: false });
  });

  it('snapshots the rate: changing it later never changes an existing order', async () => {
    const res = await webOrder([{ productId: ids.tee.id, quantity: 1 }], {}, '+919800000003');
    expect(res.body.totalCents).toBe(1770);
    await patch(`/api/tax-rates/${gst18}`, { rateBp: 1200 }, admin);
    const o = (await t.c.orders.getByNumber(res.body.number))!;
    expect(o.totalCents).toBe(1770);
    expect((await t.pool.query('SELECT tax_rate_bp FROM order_items WHERE order_id = $1', [o.id])).rows[0].tax_rate_bp).toBe(1800);
    expect((await webOrder([{ productId: ids.tee.id, quantity: 1 }], {}, '+919800000004')).body.totalCents).toBe(1680); // new rate: 12%
    await patch(`/api/tax-rates/${gst18}`, { rateBp: 1800 }, admin);
  });

  it('untaxed products behave exactly as before', async () => {
    const res = await webOrder([{ productId: ids.mug.id, quantity: 3 }], {}, '+919800000005');
    expect(res.body.totalCents).toBe(2400);
  });
});

describe('discounts (T64)', () => {
  it('staff can discount lines and the whole order; the server computes every figure', async () => {
    const customerId = (await t.c.customers.findOrCreateByChannel('web', '919800000010', 'Wholesale')).id;
    const res = await post('/api/orders', {
      customerId,
      items: [{ productId: ids.tee.id, quantity: 2, discount: { type: 'percent', basisPoints: 1000 } }, { productId: ids.mug.id, quantity: 1 }],
      discount: { type: 'fixed', cents: 100 },
    });
    expect(res.status).toBe(201);
    // tee: 3000 - 300 = 2700 ; mug 800 ; order discount 100 shared by 2700:800 -> 77 and 23
    // tee net 2623 + 18% (472) = 3095 ; mug net 777 untaxed
    expect(res.body).toMatchObject({ discountCents: 400, taxCents: 472, subtotalCents: 3400, totalCents: 3872 });
    expect(res.body.items.find((i: { sku: string }) => i.sku === 'TEE')).toMatchObject({ taxRateBp: 1800, discountCents: 377 });
  });

  it('refuses a discount larger than the amount, and bad shapes', async () => {
    const customerId = (await t.c.customers.findOrCreateByChannel('web', '919800000011', 'X')).id;
    const item = { productId: ids.mug.id, quantity: 1 };
    expect((await post('/api/orders', { customerId, items: [item], discount: { type: 'fixed', cents: 801 } })).status).toBe(400);
    expect((await post('/api/orders', { customerId, items: [{ ...item, discount: { type: 'percent', basisPoints: 10001 } }] })).status).toBe(400);
    expect((await post('/api/orders', { customerId, items: [item], discount: { type: 'fixed', cents: -5 } })).status).toBe(400);
    expect((await post('/api/orders', { customerId, items: [item], discount: { type: 'fixed' } })).status).toBe(400);
  });

  it('customers can never discount themselves: the web ignores it and the service refuses it', async () => {
    const res = await webOrder([{ productId: ids.mug.id, quantity: 1 }], { discount: { type: 'percent', basisPoints: 10000 }, discountCents: 800 }, '+919800000012');
    expect(res.body.totalCents).toBe(800);
    const customerId = (await t.c.customers.findOrCreateByChannel('web', '919800000013', 'Y')).id;
    await expect(t.c.orders.create({ customerId, channel: 'web', items: [{ productId: ids.mug.id, quantity: 1 }], discount: { type: 'fixed', cents: 1 } })).rejects.toMatchObject({ status: 400 });
    await expect(t.c.orders.create({ customerId, channel: 'whatsapp', items: [{ productId: ids.mug.id, quantity: 1, discount: { type: 'fixed', cents: 1 } }] })).rejects.toMatchObject({ status: 400 });
  });
});

describe('quotes, chat and payments show the same total (T64)', () => {
  it('the public quote equals the order total, with a breakdown', async () => {
    const items = [{ productId: ids.tee.id, quantity: 3 }, { productId: ids.mug.id, quantity: 2 }];
    const q = await request(t.app).post('/api/public/quote').send({ items });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ subtotalCents: 6100, taxCents: 810, discountCents: 0, totalCents: 6910, inclusive: false });
    const order = await webOrder(items, {}, '+919800000020');
    expect(order.body.totalCents).toBe(q.body.totalCents);
  });

  it('rejects quotes for unknown products or bad quantities', async () => {
    const bad = (items: unknown) => request(t.app).post('/api/public/quote').send({ items });
    expect((await bad([{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }])).status).toBe(404);
    expect((await bad([{ productId: ids.tee.id, quantity: 0 }])).status).toBe(400);
    expect((await bad([])).status).toBe(400);
  });

  it('the chat cart shows the taxed total and the placed order matches it', async () => {
    const tap = (action: string) => t.c.bot.handle({ channel: 'whatsapp', from: '919800000030', text: action, action, senderName: 'Chatty' });
    const added = await tap(`qty:${ids.tee.id}:2`);
    expect(added.text).toMatch(/35\.40/);
    expect((await tap('cart')).text).toMatch(/Total: .*35\.40/);
    const placed = await tap('pay:cod');
    expect(placed.text).toMatch(/35\.40/);
    const customerId = (await t.c.customers.findOrCreateByChannel('whatsapp', '919800000030', 'Chatty')).id;
    expect((await t.c.orders.list({ customerId }))[0]!.totalCents).toBe(3540);
  });

  it('the Razorpay payment link is for the final taxed total', async () => {
    const res = await webOrder([{ productId: ids.tee.id, quantity: 2 }], { paymentMethod: 'ONLINE' }, '+919800000040');
    expect(res.status).toBe(201);
    expect((rz.links().at(-1)!.body as { amount: number }).amount).toBe(3540);
  });
});
