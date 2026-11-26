import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { loadEnv } from '../src/config/env.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay, paidLinkEvent, refundEvent, signedRazorpayWebhook } from './helpers/fakeRazorpay.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>; let staff: string; let viewer: string;
const rzp = fakeRazorpay();
const sent: { to: string; text: string }[] = [];
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });

beforeAll(async () => {
  t = await buildTestApp({ ...RZP }, { fetch: rzp.fn, messenger: { send: async (_c, to, text) => { sent.push({ to, text }); } } });
  staff = await t.token('staff'); viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 100 }, null);
  await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id });
});
afterAll(async () => { await t.close(); });

let n = 0;
/** Paid online order (₹30.00) cancelled afterwards: REFUND_DUE. `paidPaise` lets a test pay a different amount than expected. */
async function refundDue(paidPaise = 3000) {
  const who = `97${String(++n).padStart(8, '0')}`;
  const customerId = (await t.c.customers.findOrCreateByChannel('whatsapp', who, 'Refund Tester')).id;
  const order = await t.c.orders.create({ customerId, channel: 'whatsapp', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 2 }] });
  const plink = (await t.c.payments.linkForOrder(order.id)).providerRef;
  await signedRazorpayWebhook(t.app, paidLinkEvent(plink, paidPaise), { eventId: `evt_ra_${n}` });
  await t.c.orders.cancel(order.id, null);
  return { order, who, razorpayPaymentId: `pay_${plink}` };
}
const refund = (orderId: string, body: object = {}, tok = staff) => request(t.app).post(`/api/orders/${orderId}/refund`).set(h(tok)).send(body);
const pay = async (orderId: string) => (await t.pool.query('SELECT id, refund_status, refund_id, refund_error, refund_attempts, paid_cents FROM payments WHERE order_id = $1', [orderId])).rows[0];

describe('POST /api/orders/:id/refund', () => {
  it('refunds the captured amount at Razorpay, stays REFUND_DUE until the signed webhook confirms', async () => {
    const r = await refundDue();
    rzp.calls.length = 0;
    const res = await refund(r.order.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.refund).toMatchObject({ status: 'PENDING', id: expect.stringMatching(/^rfnd_/) });
    expect(res.body.order.paymentStatus).toBe('REFUND_DUE');
    const call = rzp.refunds()[0]!;
    expect(call.url).toContain(`/v1/payments/${r.razorpayPaymentId}/refund`);
    expect(call.body).toMatchObject({ amount: 3000, speed: 'normal' });
    expect(call.headers['x-refund-idempotency']).toMatch(/^refund-/);
    expect(await pay(r.order.id)).toMatchObject({ refund_status: 'PENDING', refund_id: res.body.refund.id });

    await signedRazorpayWebhook(t.app, refundEvent('processed', res.body.refund.id, r.razorpayPaymentId, 3000), { eventId: `evt_rp_${n}` });
    expect((await t.c.orders.get(r.order.id))!.paymentStatus).toBe('REFUNDED');
  });

  it('the amount comes from our records: anything the client sends is ignored, and a short or odd payment refunds exactly what was captured', async () => {
    const r = await refundDue(2500); // paid ₹25.00 against a ₹30.00 order → flagged for refund
    rzp.calls.length = 0;
    expect((await refund(r.order.id, { amount: 1, amountCents: 999999, paymentId: 'pay_other' })).status).toBe(200);
    expect(rzp.refunds()[0]!.body).toMatchObject({ amount: 2500 });
    expect(rzp.refunds()[0]!.url).toContain(r.razorpayPaymentId);
    const row = await pay(r.order.id);
    expect(row.paid_cents).toBe(2500);
  });

  it('payments recorded before paid_cents existed fall back to the expected amount', async () => {
    const r = await refundDue();
    await t.pool.query('UPDATE payments SET paid_cents = NULL WHERE order_id = $1', [r.order.id]);
    rzp.calls.length = 0;
    expect((await refund(r.order.id)).status).toBe(200);
    expect(rzp.refunds()[0]!.body).toMatchObject({ amount: 3000 });
  });

  it('simultaneous clicks issue one refund', async () => {
    const r = await refundDue();
    rzp.calls.length = 0;
    const codes = (await Promise.all(Array.from({ length: 6 }, () => refund(r.order.id)))).map((x) => x.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    expect(rzp.refunds()).toHaveLength(1);
  });

  it('only refund-due orders with a captured payment, only by staff', async () => {
    const r = await refundDue();
    expect((await refund('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await refund(r.order.id, {}, viewer)).status).toBe(403);
    expect((await request(t.app).post(`/api/orders/${r.order.id}/refund`).send({})).status).toBe(401);
    const cod = await t.c.orders.create({ customerId: (await t.c.customers.findOrCreateByChannel('whatsapp', '9700000000', 'Cod')).id, channel: 'whatsapp', items: [{ productId: ids.tee.id, quantity: 1 }] });
    expect((await refund(cod.id)).status).toBe(409);                                   // not paid, not refund-due
    await t.pool.query("UPDATE orders SET payment_status = 'PAID' WHERE id = $1", [r.order.id]);
    expect((await refund(r.order.id)).status).toBe(409);                                // PAID is not REFUND_DUE
    await t.pool.query("UPDATE orders SET payment_status = 'REFUND_DUE' WHERE id = $1", [r.order.id]);
    await t.pool.query('UPDATE payments SET provider_payment_id = NULL WHERE order_id = $1', [r.order.id]);
    expect((await refund(r.order.id)).status).toBe(409);                                // no captured payment id on record
  });

  it('a Razorpay rejection is reported, recorded, leaves the order REFUND_DUE, and a retry uses a new request', async () => {
    const r = await refundDue();
    rzp.setRefundFailure(400);
    const res = await refund(r.order.id);
    rzp.setRefundFailure(null);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/greater than the amount/);
    expect(await pay(r.order.id)).toMatchObject({ refund_status: 'FAILED', refund_attempts: 1 });
    expect((await t.c.orders.get(r.order.id))!.paymentStatus).toBe('REFUND_DUE');
    rzp.calls.length = 0;
    expect((await refund(r.order.id)).status).toBe(200);
    expect(await pay(r.order.id)).toMatchObject({ refund_status: 'PENDING', refund_attempts: 2 });
    expect(rzp.refunds()[0]!.headers['x-refund-idempotency']).toMatch(/-2$/);
  });

  it('after an outage the answer is unknown: a quick retry is refused, a later retry repeats the SAME request so it cannot refund twice', async () => {
    const r = await refundDue();
    const before = rzp.refundCount();
    rzp.setFailing(true);
    const down = await refund(r.order.id);
    rzp.setFailing(false);
    expect(down.status).toBe(502);
    expect(await pay(r.order.id)).toMatchObject({ refund_status: 'PENDING', refund_id: null, refund_attempts: 1 });
    expect((await refund(r.order.id)).status).toBe(409);                                       // too soon: it may still be in flight
    await t.pool.query("UPDATE payments SET updated_at = now() - interval '2 minutes' WHERE order_id = $1", [r.order.id]);
    rzp.calls.length = 0;
    expect((await refund(r.order.id)).status).toBe(200);
    expect(await pay(r.order.id)).toMatchObject({ refund_status: 'PENDING', refund_attempts: 1 }); // same attempt → same idempotency key
    expect(rzp.refunds()[0]!.headers['x-refund-idempotency']).toMatch(/-1$/);
    expect(rzp.refundCount()).toBe(before + 1);
  });

  it('is refused when Razorpay is not configured', async () => {
    const r = await refundDue();
    // A second app on the SAME database (never reset the DB inside a test file) whose server has no Razorpay keys.
    const bare = createApp(createContainer({ env: loadEnv({ ...TEST_ENV }), pool: t.pool, fetch: fakeRazorpay().fn }));
    const res = await request(bare).post(`/api/orders/${r.order.id}/refund`).set(h(staff)).send({});
    expect(res.status).toBe(501);
    expect((await t.c.orders.get(r.order.id))!.paymentStatus).toBe('REFUND_DUE');
  });

  it('the order list shows the refund state to staff', async () => {
    const r = await refundDue();
    await refund(r.order.id);
    const list = await request(t.app).get('/api/orders').set(h(staff));
    expect(list.body.find((o: { id: string }) => o.id === r.order.id)).toMatchObject({ paymentStatus: 'REFUND_DUE', refundStatus: 'PENDING' });
  });
});
