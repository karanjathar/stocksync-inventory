import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay } from './helpers/fakeRazorpay.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'ws', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp;
let rz: ReturnType<typeof fakeRazorpay>;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let customerId: string;
const order = (method: 'ONLINE' | 'COD' = 'ONLINE', qty = 2) => t.c.orders.create({ customerId, channel: 'web', paymentMethod: method, items: [{ productId: ids.tee.id, quantity: qty }] });

beforeAll(async () => {
  rz = fakeRazorpay();
  t = await buildTestApp(RZP, { fetch: rz.fn });
  ids = await seedCatalog(t, await t.token('staff')); // TEE 1500
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 50 }, null);
  await t.c.settings.update({ currency: 'INR', businessName: 'Corner Shop' });
  customerId = (await t.c.customers.findOrCreateByChannel('web', '919811112222', 'Asha')).id;
});
afterAll(async () => { await t.close(); });

describe('payment settings & config (T35)', () => {
  it('settings expose payment defaults and validate updates', async () => {
    expect((await t.c.settings.get()).payments).toEqual({ onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 });
    const admin = await t.token('admin');
    expect((await request(t.app).put('/api/settings').set({ authorization: `Bearer ${admin}` }).send({ payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 5 } })).status).toBe(400);
    expect((await request(t.app).put('/api/settings').set({ authorization: `Bearer ${admin}` }).send({ payments: { onlineEnabled: true, codEnabled: false, linkExpiryMinutes: 60 } })).body.payments)
      .toEqual({ onlineEnabled: true, codEnabled: false, linkExpiryMinutes: 60 });
    await t.c.settings.update({ payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 } });
  });

  it('GET /api/payments/config explains availability', async () => {
    const tok = await t.token('viewer');
    const get = async () => (await request(t.app).get('/api/payments/config').set({ authorization: `Bearer ${tok}` })).body;
    expect(await get()).toEqual({ razorpayConfigured: true, onlineAvailable: true, codEnabled: true });
    await t.c.settings.update({ currency: 'USD' });
    expect(await get()).toMatchObject({ onlineAvailable: false, reason: expect.stringMatching(/INR/) });
    await t.c.settings.update({ currency: 'INR', payments: { onlineEnabled: false, codEnabled: true, linkExpiryMinutes: 1440 } });
    expect(await get()).toMatchObject({ onlineAvailable: false, reason: expect.stringMatching(/disabled/i) });
    await t.c.settings.update({ payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 } });
  });
});

describe('payment links for orders (T35)', () => {
  it('creates a link from the server-side total in paise with callback to the public order page', async () => {
    const o = await order();
    const before = Date.now();
    const p = await t.c.payments.linkForOrder(o.id);
    expect(p).toMatchObject({ orderId: o.id, status: 'CREATED', amountCents: 3000, currency: 'INR', shortUrl: 'https://rzp.io/i/link1', providerRef: 'plink_1' });
    const body = rz.links().at(-1)!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      amount: 3000, currency: 'INR', reference_id: p.referenceId, description: `Corner Shop order #${o.number}`,
      customer: { name: 'Asha' }, callback_url: `https://shop.example.com/shop/order/${o.publicToken}`,
      notes: { order_id: o.id, order_number: String(o.number) },
    });
    expect(p.referenceId).toMatch(new RegExp(`^ORD-${o.number}-[a-z0-9]{6}$`));
    const expireBy = (body.expire_by as number) * 1000;
    expect(expireBy - before).toBeGreaterThanOrEqual(1440 * 60_000 - 5000);
  });

  it('sends the phone to Razorpay only when it is known to include a country code (WhatsApp), never a guessed web number (T54)', async () => {
    const lastCustomer = () => (rz.links().at(-1)!.body as { customer: unknown }).customer;
    const local = await t.c.customers.findOrCreateByChannel('web', '9811112233', 'Local Shopper'); // typed without a country code
    const webOrder = await t.c.orders.create({ customerId: local.id, channel: 'web', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 1 }] });
    await t.c.payments.linkForOrder(webOrder.id);
    expect(lastCustomer()).toEqual({ name: 'Local Shopper' });
    const wa = await t.c.customers.findOrCreateByChannel('whatsapp', '919811112222', 'Wa Asha'); // wa_id always has the country code
    const waOrder = await t.c.orders.create({ customerId: wa.id, channel: 'whatsapp', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 1 }] });
    await t.c.payments.linkForOrder(waOrder.id);
    expect(lastCustomer()).toEqual({ name: 'Wa Asha', contact: '+919811112222' });
    const tg = await t.c.customers.findOrCreateByChannel('telegram', '555', 'Tg User'); // no phone at all
    const tgOrder = await t.c.orders.create({ customerId: tg.id, channel: 'telegram', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 1 }] });
    await t.c.payments.linkForOrder(tgOrder.id);
    expect(lastCustomer()).toEqual({ name: 'Tg User' });
  });

  it('reuses an open unexpired link instead of creating duplicates (also under concurrency)', async () => {
    const o = await order();
    const before = rz.links().length;
    const [a, b, c] = await Promise.all([t.c.payments.linkForOrder(o.id), t.c.payments.linkForOrder(o.id), t.c.payments.linkForOrder(o.id)]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    const open = await t.pool.query("SELECT count(*)::int AS n FROM payments WHERE order_id = $1 AND status = 'CREATED'", [o.id]);
    expect(open.rows[0].n).toBe(1);
    // losing racers' links (if any were created at Razorpay) are cancelled, never left payable
    const created = rz.links().length - before;
    expect(rz.calls.filter((x) => x.url.includes('/cancel')).length).toBeGreaterThanOrEqual(created - 1);
  });

  it('replaces an expired open link', async () => {
    const o = await order();
    const first = await t.c.payments.linkForOrder(o.id);
    await t.pool.query("UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = $1", [first.id]);
    const second = await t.c.payments.linkForOrder(o.id);
    expect(second.id).not.toBe(first.id);
    const old = await t.pool.query('SELECT status FROM payments WHERE id = $1', [first.id]);
    expect(old.rows[0].status).toBe('EXPIRED');
  });

  it('switches a COD order to ONLINE when a link is requested, and refuses paid/cancelled orders', async () => {
    const cod = await order('COD');
    await t.c.payments.linkForOrder(cod.id);
    expect((await t.c.orders.get(cod.id))!.paymentMethod).toBe('ONLINE');
    const paid = await order();
    await t.pool.query("UPDATE orders SET payment_status = 'PAID' WHERE id = $1", [paid.id]);
    await expect(t.c.payments.linkForOrder(paid.id)).rejects.toMatchObject({ status: 409 });
    const cancelled = await order();
    await t.c.orders.cancel(cancelled.id, null);
    await expect(t.c.payments.linkForOrder(cancelled.id)).rejects.toMatchObject({ status: 409 });
    await expect(t.c.payments.linkForOrder('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when online payments are unavailable (501)', async () => {
    const o = await order();
    await t.c.settings.update({ currency: 'USD' });
    await expect(t.c.payments.linkForOrder(o.id)).rejects.toMatchObject({ status: 501 });
    await t.c.settings.update({ currency: 'INR' });
  });
});

describe('link creation holds no database connection while waiting on Razorpay (T51)', () => {
  it('stays responsive when Razorpay is slow and the pool is smaller than the number of requests', async () => {
    const orders = await Promise.all(Array.from({ length: 15 }, () => order('ONLINE', 1))); // pool max is 10
    rz.setDelay(2000);
    const inflight = orders.map((o) => t.c.payments.linkForOrder(o.id));
    await new Promise((r) => setTimeout(r, 400)); // every request is now waiting on Razorpay
    const t0 = Date.now();
    const health = await request(t.app).get('/healthz');
    const ms = Date.now() - t0;
    rz.setDelay(0);
    expect(health.status).toBe(200);
    expect(ms).toBeLessThan(1000);
    const links = await Promise.all(inflight);
    expect(new Set(links.map((l) => l.orderId)).size).toBe(15);
  }, 20000);

  it('an order cancelled while its link is being created ends with no payable link', async () => {
    const o = await order('ONLINE', 1);
    const original = t.c.razorpay.createPaymentLink.bind(t.c.razorpay);
    const spy = vi.spyOn(t.c.razorpay, 'createPaymentLink').mockImplementationOnce(async (input) => {
      await t.c.orders.cancel(o.id, null); // staff cancel while Razorpay is still answering
      return original(input);
    });
    const cancelsBefore = rz.calls.filter((c) => c.url.endsWith('/cancel')).length;
    try {
      await expect(t.c.payments.linkForOrder(o.id)).rejects.toMatchObject({ status: 409 });
    } finally {
      spy.mockRestore();
    }
    const open = await t.pool.query("SELECT count(*)::int AS n FROM payments WHERE order_id = $1 AND status = 'CREATED'", [o.id]);
    expect(open.rows[0].n).toBe(0);
    expect(rz.calls.filter((c) => c.url.endsWith('/cancel')).length).toBe(cancelsBefore + 1); // the just-created link was cancelled
  });
});
