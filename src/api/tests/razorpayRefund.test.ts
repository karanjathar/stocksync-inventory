import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay, paidLinkEvent, refundEvent, signedRazorpayWebhook } from './helpers/fakeRazorpay.js';
import { RazorpayClient, RazorpayError } from '../src/payments/razorpay.js';
import type { RealtimeEvent } from '../src/domain/types.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };

describe('RazorpayClient.refundPayment', () => {
  const client = (fn: typeof fetch) => new RazorpayClient({ keyId: 'rzp_test_x', keySecret: 'ks', webhookSecret: 'w', apiBase: 'https://api.razorpay.com' }, fn);
  const capture = (status = 200, body: unknown = { id: 'rfnd_9', entity: 'refund', payment_id: 'pay_1', amount: 3000, status: 'processed' }) => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fn = (async (u: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(u), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> }); return Response.json(body, { status }); }) as typeof fetch;
    return { fn, calls };
  };

  it('sends the documented request: amount in paise, normal speed, receipt, idempotency key, Basic auth', async () => {
    const c = capture();
    const refund = await client(c.fn).refundPayment({ paymentId: 'pay_1', amountCents: 3000, receipt: 'order-17', idempotencyKey: 'refund-abc', notes: { orderNumber: '17' } });
    expect(refund).toEqual({ id: 'rfnd_9', status: 'processed', amountCents: 3000 });
    const call = c.calls[0]!;
    expect(call.url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund');
    expect(call.body).toEqual({ amount: 3000, speed: 'normal', receipt: 'order-17', notes: { orderNumber: '17' } });
    expect(call.headers.get('x-refund-idempotency')).toBe('refund-abc');
    expect(call.headers.get('authorization')).toBe(`Basic ${Buffer.from('rzp_test_x:ks').toString('base64')}`);
  });

  it('refuses to send nonsense and never puts secrets in errors', async () => {
    const c = capture();
    for (const bad of [{ amountCents: 0 }, { amountCents: -5 }, { amountCents: 10.5 }, { paymentId: 'not_a_payment' }, { paymentId: 'pay_1/../x' }]) {
      await expect(client(c.fn).refundPayment({ paymentId: 'pay_1', amountCents: 100, receipt: 'r', idempotencyKey: 'k', ...bad }), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(c.calls).toHaveLength(0);
    const failing = capture(400, { error: { description: 'The refund amount is greater than the payment amount' } });
    const err = await client(failing.fn).refundPayment({ paymentId: 'pay_1', amountCents: 100, receipt: 'r', idempotencyKey: 'k' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RazorpayError);
    expect(String(err)).toContain('greater than the payment amount');
    expect(String(err)).not.toContain('ks');
  });

  it('rejects an unexpected response shape', async () => {
    await expect(client(capture(200, { id: 'something_else', status: 'x' }).fn).refundPayment({ paymentId: 'pay_1', amountCents: 100, receipt: 'r', idempotencyKey: 'k' })).rejects.toThrow(/unexpected response/);
  });
});

describe('refund webhook events', () => {
  let t: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>; let staff: string;
  const sent: { to: string; text: string }[] = [];
  const events: RealtimeEvent[] = [];
  beforeAll(async () => {
    t = await buildTestApp({ ...RZP }, { fetch: fakeRazorpay().fn, messenger: { send: async (_c, to, text) => { sent.push({ to, text }); } } });
    staff = await t.token('staff');
    ids = await seedCatalog(t, staff);
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 100 }, null);
    await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id, alertRecipients: [{ channel: 'telegram', to: 'owner' }] });
    t.c.events.subscribe((e) => events.push(e));
  });
  afterAll(async () => { await t.close(); });

  let n = 0;
  /** A paid online order that was then cancelled: REFUND_DUE, with the real payment id recorded. */
  async function refundDue() {
    const who = `98${String(++n).padStart(8, '0')}`;
    const customerId = (await t.c.customers.findOrCreateByChannel('whatsapp', who, 'Refund Tester')).id;
    const order = await t.c.orders.create({ customerId, channel: 'whatsapp', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 2 }] });
    const plink = (await t.c.payments.linkForOrder(order.id)).providerRef;
    await signedRazorpayWebhook(t.app, paidLinkEvent(plink, 3000), { eventId: `evt_paid_${n}` });
    await t.c.orders.cancel(order.id, null);
    const payment = (await t.pool.query('SELECT id, provider_payment_id FROM payments WHERE order_id = $1', [order.id])).rows[0] as { id: string; provider_payment_id: string };
    return { order, who, paymentId: payment.id, razorpayPaymentId: payment.provider_payment_id };
  }
  const hook = (body: unknown, eventId: string) => signedRazorpayWebhook(t.app, body, { eventId });
  const paymentRow = async (id: string) => (await t.pool.query('SELECT refund_id, refund_status, refund_error FROM payments WHERE id = $1', [id])).rows[0];
  const orderPay = async (id: string) => (await t.c.orders.get(id))!.paymentStatus;

  it('refund.processed marks the order refunded, records the refund and tells the customer once', async () => {
    const r = await refundDue();
    await t.pool.query("UPDATE payments SET refund_status = 'PENDING', refund_id = 'rfnd_x1' WHERE id = $1", [r.paymentId]);
    sent.length = 0; events.length = 0;
    expect((await hook(refundEvent('processed', 'rfnd_x1', r.razorpayPaymentId, 3000), 'evt_rp_1')).status).toBe(200);
    expect(await orderPay(r.order.id)).toBe('REFUNDED');
    expect(await paymentRow(r.paymentId)).toMatchObject({ refund_status: 'PROCESSED', refund_id: 'rfnd_x1' });
    expect(sent.filter((m) => m.to === r.who && /refund/i.test(m.text))).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'payment.updated', orderId: r.order.id, paymentStatus: 'REFUNDED' }));
  });

  it('a replayed event, or a second event for the same refund, never messages the customer again', async () => {
    const r = await refundDue();
    await t.pool.query("UPDATE payments SET refund_status = 'PENDING', refund_id = 'rfnd_x2' WHERE id = $1", [r.paymentId]);
    sent.length = 0;
    await hook(refundEvent('processed', 'rfnd_x2', r.razorpayPaymentId, 3000), 'evt_rp_2');
    await hook(refundEvent('processed', 'rfnd_x2', r.razorpayPaymentId, 3000), 'evt_rp_2');     // same event id: replay
    await hook(refundEvent('processed', 'rfnd_x2', r.razorpayPaymentId, 3000), 'evt_rp_2b');    // new event id, same refund
    expect(sent.filter((m) => m.to === r.who && /refund/i.test(m.text))).toHaveLength(1);
    expect(await orderPay(r.order.id)).toBe('REFUNDED');
  });

  it('does not message again when staff had already marked the refund done by hand', async () => {
    const r = await refundDue();
    await request(t.app).post(`/api/orders/${r.order.id}/refunded`).set({ authorization: `Bearer ${staff}` }).send({});
    sent.length = 0;
    await hook(refundEvent('processed', 'rfnd_x3', r.razorpayPaymentId, 3000), 'evt_rp_3');
    expect(sent.filter((m) => m.to === r.who)).toHaveLength(0);
    expect(await orderPay(r.order.id)).toBe('REFUNDED');
  });

  it('refund.failed keeps the order REFUND_DUE, records the failure and alerts staff', async () => {
    const r = await refundDue();
    await t.pool.query("UPDATE payments SET refund_status = 'PENDING', refund_id = 'rfnd_x4' WHERE id = $1", [r.paymentId]);
    sent.length = 0;
    await hook(refundEvent('failed', 'rfnd_x4', r.razorpayPaymentId, 3000), 'evt_rf_4');
    expect(await orderPay(r.order.id)).toBe('REFUND_DUE');
    expect(await paymentRow(r.paymentId)).toMatchObject({ refund_status: 'FAILED' });
    expect((await paymentRow(r.paymentId)).refund_error).toBeTruthy();
    expect(sent.some((m) => m.to === 'owner' && m.text.includes(`#${r.order.number}`) && /failed/i.test(m.text))).toBe(true);
    expect(sent.some((m) => m.to === r.who)).toBe(false); // the customer is not told about the failure
  });

  it('a refund of an extra (duplicate) payment on an order that stays PAID changes only the payment', async () => {
    const r = await refundDue();
    await t.pool.query("UPDATE orders SET payment_status = 'PAID' WHERE id = $1", [r.order.id]);
    await hook(refundEvent('processed', 'rfnd_x5', r.razorpayPaymentId, 3000), 'evt_rp_5');
    expect(await orderPay(r.order.id)).toBe('PAID');
    expect(await paymentRow(r.paymentId)).toMatchObject({ refund_status: 'PROCESSED', refund_id: 'rfnd_x5' });
  });

  it('acknowledges events for unknown payments and forged signatures change nothing', async () => {
    expect((await hook(refundEvent('processed', 'rfnd_zz', 'pay_unknown', 100), 'evt_rp_unknown')).status).toBe(200);
    const r = await refundDue();
    const raw = JSON.stringify(refundEvent('processed', 'rfnd_x6', r.razorpayPaymentId, 3000));
    const forged = await request(t.app).post('/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', 'a'.repeat(64)).set('x-razorpay-event-id', 'evt_forged').send(raw);
    expect(forged.status).toBe(401);
    expect(await orderPay(r.order.id)).toBe('REFUND_DUE');
  });
});
