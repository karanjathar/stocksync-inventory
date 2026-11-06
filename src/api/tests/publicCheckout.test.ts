import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay, paidLinkEvent, signedRazorpayWebhook } from './helpers/fakeRazorpay.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp;
let rz: ReturnType<typeof fakeRazorpay>;
let ids: Awaited<ReturnType<typeof seedCatalog>>;

const setPayments = (p: Partial<{ onlineEnabled: boolean; codEnabled: boolean }>) =>
  t.c.settings.update({ payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440, ...p } });
const place = (body: object = {}) => request(t.app).post('/api/public/orders').send({
  name: 'Mia', phone: '+919811112233', items: [{ productId: ids.tee.id, quantity: 2 }], ...body,
});

beforeAll(async () => {
  rz = fakeRazorpay();
  t = await buildTestApp(RZP, { fetch: rz.fn });
  ids = await seedCatalog(t, await t.token('staff')); // TEE ₹15.00
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 40 }, null);
  await t.c.settings.update({ currency: 'INR', businessName: 'Corner Shop', defaultWarehouseId: ids.main.id });
});
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.c.settings.update({ currency: 'INR' }); await setPayments({}); }); // tests never leak settings

describe('catalog payment methods (T38)', () => {
  it('lists only the methods that are actually usable', async () => {
    const methods = async () => (await request(t.app).get('/api/public/catalog')).body.settings.paymentMethods;
    expect(await methods()).toEqual(['ONLINE', 'COD']);
    await setPayments({ onlineEnabled: false });
    expect(await methods()).toEqual(['COD']);
    await setPayments({ codEnabled: false });
    expect(await methods()).toEqual(['ONLINE']);
    await setPayments({ onlineEnabled: false, codEnabled: false });
    expect(await methods()).toEqual([]);
    await t.c.settings.update({ currency: 'USD' });
    await setPayments({});
    expect(await methods()).toEqual(['COD']); // Razorpay Payment Links need INR
    await t.c.settings.update({ currency: 'INR' });
  });
});

describe('POST /api/public/orders (T38)', () => {
  it('defaults to cash on delivery and returns an unguessable tracking token', async () => {
    const res = await place();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ number: expect.any(Number), status: 'PENDING', totalCents: 3000, paymentMethod: 'COD', token: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await t.c.orders.getByNumber(res.body.number)).toMatchObject({ channel: 'web', paymentMethod: 'COD', publicToken: res.body.token });
  });

  it('ONLINE returns a Razorpay payment URL; the amount comes from the server, never the client', async () => {
    const res = await place({ paymentMethod: 'ONLINE', totalCents: 1, amount: 1, amountCents: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ paymentMethod: 'ONLINE', totalCents: 3000, paymentUrl: expect.stringMatching(/^https:\/\/rzp\.io\/i\/link\d+$/) });
    const body = rz.links().at(-1)!.body as { amount: number; callback_url: string };
    expect(body.amount).toBe(3000);
    expect(body.callback_url).toBe(`https://shop.example.com/shop/order/${res.body.token}`);
  });

  it('rejects disabled or unavailable methods with 409', async () => {
    await setPayments({ onlineEnabled: false });
    expect((await place({ paymentMethod: 'ONLINE' })).status).toBe(409);
    await setPayments({ codEnabled: false });
    expect((await place({ paymentMethod: 'COD' })).status).toBe(409);
    await setPayments({ onlineEnabled: false, codEnabled: false });
    expect((await place()).status).toBe(409); // nothing enabled → cannot default
    await setPayments({ onlineEnabled: true, codEnabled: false });
    const onlyOnline = await place(); // omitted method falls back to the only enabled one
    expect(onlyOnline.status).toBe(201);
    expect(onlyOnline.body.paymentMethod).toBe('ONLINE');
    await setPayments({});
    expect((await place({ paymentMethod: 'CRYPTO' })).status).toBe(400);
  });

  it('a payment-provider outage returns 502 and leaves no orphan pending order', async () => {
    const before = (await t.c.orders.list({ status: 'PENDING' })).length;
    rz.setFailing(true);
    const res = await place({ paymentMethod: 'ONLINE' });
    rz.setFailing(false);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect((await t.c.orders.list({ status: 'PENDING' })).length).toBe(before);
    const cancelled = await t.c.orders.list({ status: 'CANCELLED' });
    expect(cancelled.some((o) => o.channel === 'web' && o.paymentMethod === 'ONLINE')).toBe(true);
  });

  it('still refuses quantities above stock and bad input', async () => {
    expect((await place({ items: [{ productId: ids.tee.id, quantity: 999 }], paymentMethod: 'ONLINE' })).status).toBe(409);
    expect((await place({ name: '', phone: 'x', items: [] })).status).toBe(400);
  });
});

describe('GET /api/public/orders/:token (T38)', () => {
  it('returns only safe fields, never personal data or internal ids', async () => {
    const placed = await place({ paymentMethod: 'ONLINE' });
    const res = await request(t.app).get(`/api/public/orders/${placed.body.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toEqual({
      number: placed.body.number, status: 'PENDING', paymentMethod: 'ONLINE', paymentStatus: 'UNPAID',
      totalCents: 3000, currency: 'INR', items: [{ name: 'T-Shirt', quantity: 2 }], paymentUrl: placed.body.paymentUrl,
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Mia|919811112233|customer|publicToken|warehouse|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('follows the order through payment: PAID + CONFIRMED, and the pay URL disappears', async () => {
    const placed = await place({ paymentMethod: 'ONLINE' });
    const plink = (await t.pool.query('SELECT provider_ref FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_token = $1', [placed.body.token])).rows[0].provider_ref as string;
    expect((await signedRazorpayWebhook(t.app, paidLinkEvent(plink, 3000), { eventId: 'evt_pub_1' })).status).toBe(200);
    const res = await request(t.app).get(`/api/public/orders/${placed.body.token}`);
    expect(res.body).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
    expect(res.body).not.toHaveProperty('paymentUrl');
  });

  it('cash-on-delivery orders have no pay URL; unknown, malformed and order-number lookups are 404', async () => {
    const cod = await place();
    expect((await request(t.app).get(`/api/public/orders/${cod.body.token}`)).body).not.toHaveProperty('paymentUrl');
    expect((await request(t.app).get('/api/public/orders/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await request(t.app).get('/api/public/orders/not-a-token')).status).toBe(404);
    expect((await request(t.app).get(`/api/public/orders/${cod.body.number}`)).status).toBe(404); // numbers are guessable, tokens are not
  });
});
