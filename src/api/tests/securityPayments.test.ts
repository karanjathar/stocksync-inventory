// Security regression suite for Release 2 (payments + interactive chat). Maps to docs/7_SECURITY_AUDIT.md §7.R2.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay, paidLinkEvent, signedRazorpayWebhook } from './helpers/fakeRazorpay.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp;
let rz: ReturnType<typeof fakeRazorpay>;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
const sent: { to: string; text: string }[] = [];

beforeAll(async () => {
  rz = fakeRazorpay();
  t = await buildTestApp(RZP, { fetch: rz.fn, messenger: { send: async (_c, to, text) => { sent.push({ to, text }); } } });
  ids = await seedCatalog(t, await t.token('staff')); // TEE ₹15.00
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 500 }, null);
  await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id });
});
afterAll(async () => { await t.close(); });

const stockOf = async () => (await t.c.stock.levels({ productId: ids.tee.id }))[0]!.quantity;
const placeWeb = (body: object = {}) => request(t.app).post('/api/public/orders').send({
  name: 'Mia', phone: '+919800000001', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 2 }], ...body,
});
const plinkOf = async (token: string) => (await t.pool.query('SELECT p.provider_ref FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_token = $1 ORDER BY p.created_at DESC', [token])).rows[0].provider_ref as string;
const statusOf = async (token: string) => (await request(t.app).get(`/api/public/orders/${token}`)).body as { status: string; paymentStatus: string };
const hmac = (raw: string, secret = 'whsec') => createHmac('sha256', secret).update(raw).digest('hex');

describe('R2-1 amount tampering', () => {
  it('the amount sent to Razorpay is always the server-side total, whatever the client sends', async () => {
    const res = await placeWeb({ totalCents: 1, amount: 1, amountCents: 1, items: [{ productId: ids.tee.id, quantity: 2, unitPriceCents: 1, priceCents: 1, price: 0.01 }] });
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(3000);
    expect((rz.links().at(-1)!.body as { amount: number }).amount).toBe(3000);
  });

  it('staff cannot choose the amount of a payment link either', async () => {
    const o = await t.c.orders.create({ customerId: (await t.c.customers.findOrCreateByChannel('web', '919800000002', 'S')).id, channel: 'web', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 3 }] });
    const res = await request(t.app).post(`/api/orders/${o.id}/payment-link`).set({ authorization: `Bearer ${await t.token('staff')}` }).send({ amount: 1, amountCents: 1, notify: false });
    expect(res.status).toBe(200);
    expect((rz.links().at(-1)!.body as { amount: number }).amount).toBe(4500);
  });

  it.each([[1500, 'underpayment'], [9000, 'overpayment']])('a %i-paise payment on a 3000-paise order (%s) is never auto-confirmed', async (paid, _label) => {
    const placed = await placeWeb();
    const before = await stockOf();
    expect((await signedRazorpayWebhook(t.app, paidLinkEvent(await plinkOf(placed.body.token), paid), { eventId: `evt_amt_${paid}` })).status).toBe(200);
    expect(await statusOf(placed.body.token)).toMatchObject({ status: 'PENDING', paymentStatus: 'REFUND_DUE' });
    expect(await stockOf()).toBe(before);
  });

  it('no API route lets anyone set a payment status directly', async () => {
    const placed = await placeWeb();
    const staff = { authorization: `Bearer ${await t.token('admin')}` };
    const order = (await t.c.orders.getByPublicToken(placed.body.token))!;
    for (const [method, path] of [['patch', `/api/orders/${order.id}`], ['put', `/api/orders/${order.id}`], ['post', `/api/orders/${order.id}/mark-paid`]] as const) {
      expect((await request(t.app)[method](path).set(staff).send({ paymentStatus: 'PAID' })).status).toBe(404);
    }
    expect((await statusOf(placed.body.token)).paymentStatus).toBe('UNPAID');
  });
});

describe('R2-2 replay', () => {
  it('five simultaneous deliveries of one signed event settle the payment exactly once', async () => {
    const placed = await placeWeb({ phone: '+919800000010' });
    const plink = await plinkOf(placed.body.token);
    const before = await stockOf();
    const results = await Promise.all(Array.from({ length: 5 }, () => signedRazorpayWebhook(t.app, paidLinkEvent(plink, 3000), { eventId: 'evt_replay_same' })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await stockOf()).toBe(before - 2);
    expect(await statusOf(placed.body.token)).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
  });

  it('replaying the same signed body under new (or missing) event ids changes nothing', async () => {
    const placed = await placeWeb({ phone: '+919800000011' });
    const plink = await plinkOf(placed.body.token);
    await signedRazorpayWebhook(t.app, paidLinkEvent(plink, 3000), { eventId: 'evt_r_a' });
    const settled = await stockOf();
    const raw = JSON.stringify(paidLinkEvent(plink, 3000));
    for (const eventId of ['evt_r_b', 'evt_r_c', undefined]) {
      const req = request(t.app).post('/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', hmac(raw));
      expect((await (eventId ? req.set('x-razorpay-event-id', eventId) : req).send(raw)).status).toBe(200);
    }
    expect(await stockOf()).toBe(settled);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_token = $1 AND p.status = \'PAID\'', [placed.body.token])).rows[0].n).toBe(1);
  });

  it('an old signed "expired" event cannot downgrade a payment that was later paid', async () => {
    const placed = await placeWeb({ phone: '+919800000012' });
    const plink = await plinkOf(placed.body.token);
    await signedRazorpayWebhook(t.app, paidLinkEvent(plink, 3000), { eventId: 'evt_dg_paid' });
    await signedRazorpayWebhook(t.app, { event: 'payment_link.expired', payload: { payment_link: { entity: { id: plink } } } }, { eventId: 'evt_dg_expired' });
    await signedRazorpayWebhook(t.app, { event: 'payment_link.cancelled', payload: { payment_link: { entity: { id: plink } } } }, { eventId: 'evt_dg_cancelled' });
    expect(await statusOf(placed.body.token)).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' });
    expect((await t.pool.query('SELECT status FROM payments WHERE provider_ref = $1', [plink])).rows[0].status).toBe('PAID');
  });
});

describe('R2-3 forged webhooks and callbacks', () => {
  it('only a correct HMAC over the exact raw body is accepted', async () => {
    const placed = await placeWeb({ phone: '+919800000020' });
    const plink = await plinkOf(placed.body.token);
    const body = paidLinkEvent(plink, 3000);
    const raw = JSON.stringify(body);
    const post = (payload: string, sig: string | undefined, type = 'application/json') => {
      const r = request(t.app).post('/webhooks/razorpay').set('content-type', type).set('x-razorpay-event-id', `evt_forge_${Math.random()}`);
      return (sig === undefined ? r : r.set('x-razorpay-signature', sig)).send(payload);
    };
    const attempts: [string, Promise<{ status: number }>][] = [
      ['no signature header', post(raw, undefined)],
      ['empty signature', post(raw, '')],
      ['non-hex signature', post(raw, 'not-a-signature')],
      ['signature of another secret', post(raw, hmac(raw, 'other-secret'))],
      ['tampered amount, original signature', post(raw.replace('"amount_paid":3000', '"amount_paid":1'), hmac(raw))],
      ['same JSON re-serialised (whitespace), original signature', post(JSON.stringify(body, null, 2), hmac(raw))],
      ['valid signature but not parsed as JSON (text/plain)', post(raw, hmac(raw), 'text/plain')],
    ];
    for (const [label, attempt] of attempts) expect({ label, status: (await attempt).status }).toEqual({ label, status: 401 });
    expect(await statusOf(placed.body.token)).toMatchObject({ status: 'PENDING', paymentStatus: 'UNPAID' });
  });

  it('the Razorpay redirect parameters are never trusted: forged "paid" callbacks change nothing', async () => {
    const placed = await placeWeb({ phone: '+919800000021' });
    const qs = 'razorpay_payment_link_status=paid&razorpay_payment_id=pay_forged&razorpay_payment_link_id=x&razorpay_signature=00';
    await request(t.app).get(`/api/public/orders/${placed.body.token}?${qs}`);
    await request(t.app).get(`/shop/order/${placed.body.token}?${qs}`);
    await request(t.app).post(`/api/public/orders/${placed.body.token}/payment-link?${qs}`).send({ razorpay_payment_link_status: 'paid', paymentStatus: 'PAID' });
    expect(await statusOf(placed.body.token)).toMatchObject({ status: 'PENDING', paymentStatus: 'UNPAID' });
  });

  it('staff payment-link actions need a signed-in staff user', async () => {
    const placed = await placeWeb({ phone: '+919800000022' });
    const order = (await t.c.orders.getByPublicToken(placed.body.token))!;
    expect((await request(t.app).post(`/api/orders/${order.id}/payment-link`).send({})).status).toBe(401);
    expect((await request(t.app).post(`/api/orders/${order.id}/payment-link`).set({ authorization: 'Bearer forged' }).send({})).status).toBe(401);
  });
});

describe('R2-4 access to other customers’ data (IDOR)', () => {
  it('the public order token is the only key: numbers, other tokens and malformed ids give 404', async () => {
    const a = await placeWeb({ phone: '+919800000030', name: 'Alice' });
    const b = await placeWeb({ phone: '+919800000031', name: 'Bob' });
    const viewA = (await request(t.app).get(`/api/public/orders/${a.body.token}`)).body;
    expect(viewA.number).toBe(a.body.number);
    expect(JSON.stringify(viewA)).not.toMatch(/Alice|Bob|919800000030|919800000031/);
    for (const key of [String(b.body.number), String(a.body.number), 'x', '../orders', `${a.body.token}x`, a.body.token.toUpperCase().replace(/-/g, '')]) {
      const got = await request(t.app).get(`/api/public/orders/${encodeURIComponent(key)}`);
      const renew = await request(t.app).post(`/api/public/orders/${encodeURIComponent(key)}/payment-link`).send({});
      expect({ key, get: got.status, renew: renew.status }).toEqual({ key, get: 404, renew: 404 });
    }
  });

  const asWa = (from: string) => ({ channel: 'whatsapp' as const, from, senderName: 'X' });
  const tap = (from: string, action: string) => t.c.bot.handle({ ...asWa(from), text: action, action });
  const text = (from: string, msg: string) => t.c.bot.handle({ ...asWa(from), text: msg });

  it('chat customers cannot read or pay another customer’s order — and cannot tell it exists', async () => {
    const A = '919811000001';
    const B = '919811000002';
    await tap(A, `qty:${ids.tee.id}:1`);
    const placed = await tap(A, 'pay:online');
    const number = Number(/#(\d+)/.exec(placed.text)![1]);
    const unknown = 99_999_999;
    expect(placed.link).toBeDefined();
    // Every entry point answers identically for "someone else's order" and "no such order".
    const same = (reply: string) => reply.replace(/\d+/g, 'N'); // the reply echoes the number that was typed
    expect(same((await text(B, `status ${number}`)).text)).toBe(same((await text(B, `status ${unknown}`)).text));
    expect((await text(B, `status ${'9'.repeat(500)}`)).text.length).toBeLessThan(120); // typed text is not reflected unbounded
    expect((await tap(B, `order:${number}`)).text).toBe((await tap(B, `order:${unknown}`)).text);
    expect((await tap(B, `paylink:${number}`)).text).toBe((await tap(B, `paylink:${unknown}`)).text);
    expect((await tap(B, `paylink:${number}`)).link).toBeUndefined();
    expect((await tap(B, 'orders')).text).toMatch(/no orders yet/i);
  });

  it('carts are private: another customer sees an empty cart and cannot check out someone else’s items', async () => {
    const A = '919811000003';
    const B = '919811000004';
    await tap(A, `qty:${ids.tee.id}:3`);
    expect((await tap(B, 'cart')).text).toMatch(/cart is empty/i);
    expect((await tap(B, 'pay:cod')).text).toMatch(/cart is empty/i);
    expect((await tap(A, 'cart')).text).toContain('3 × T-Shirt'); // untouched
  });

  it('the same id on another channel is a different customer', async () => {
    const id = '919811000005';
    await tap(id, `qty:${ids.tee.id}:1`);
    const placed = await tap(id, 'pay:cod');
    const number = Number(/#(\d+)/.exec(placed.text)![1]);
    const telegram = (action: string) => t.c.bot.handle({ channel: 'telegram', from: id, text: action, action });
    expect((await telegram('orders')).text).toMatch(/no orders yet/i);
    expect((await telegram(`order:${number}`)).text).toMatch(/couldn't find that order/i);
  });
});

describe('R2-5 transport & response headers', () => {
  it('order pages are never cached and never leak their URL as a referrer', async () => {
    const placed = await placeWeb({ phone: '+919800000040' });
    const res = await request(t.app).get(`/api/public/orders/${placed.body.token}`);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'self'");
  });
});
