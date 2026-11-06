import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay, paidLinkEvent, signedRazorpayWebhook } from './helpers/fakeRazorpay.js';
import type { RealtimeEvent } from '../src/domain/types.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let staff: string;
const sent: { to: string; text: string }[] = [];
const events: RealtimeEvent[] = [];

beforeAll(async () => {
  t = await buildTestApp(RZP, { fetch: fakeRazorpay().fn, messenger: { send: async (_c, to, text) => { sent.push({ to, text }); } } });
  staff = await t.token('staff');
  ids = await seedCatalog(t, staff);
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 100 }, null);
  await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id });
  t.c.events.subscribe((e) => events.push(e));
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const refund = (id: string, tok = staff) => request(t.app).post(`/api/orders/${id}/refunded`).set(auth(tok)).send({});

/** A paid online order for a WhatsApp customer, then cancelled by staff → REFUND_DUE. */
async function refundDueOrder(who: string) {
  const customerId = (await t.c.customers.findOrCreateByChannel('whatsapp', who, 'Refund Tester')).id;
  const order = await t.c.orders.create({ customerId, channel: 'whatsapp', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 2 }] });
  const plink = (await t.c.payments.linkForOrder(order.id)).providerRef;
  await signedRazorpayWebhook(t.app, paidLinkEvent(plink, 3000), { eventId: `evt_rf_${who}` });
  await t.c.orders.cancel(order.id, null);
  expect((await t.c.orders.get(order.id))!.paymentStatus).toBe('REFUND_DUE');
  return order;
}

describe('marking a refund as done (T58)', () => {
  it('moves REFUND_DUE → REFUNDED, publishes an event and tells the customer', async () => {
    const who = '919700000001';
    const order = await refundDueOrder(who);
    sent.length = 0;
    const res = await refund(order.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: order.id, status: 'CANCELLED', paymentStatus: 'REFUNDED' });
    expect(events).toContainEqual({ type: 'payment.updated', orderId: order.id, number: order.number, paymentStatus: 'REFUNDED' });
    const msgs = sent.filter((m) => m.to === who);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toMatch(new RegExp(`refund.*order #${order.number}|order #${order.number}.*refund`, 'i'));
    expect(msgs[0]!.text).toContain('₹30.00');
    expect(msgs[0]!.text).toMatch(/issued/i);
  });

  it('works exactly once, even for a double-click', async () => {
    const who = '919700000002';
    const order = await refundDueOrder(who);
    sent.length = 0;
    const results = await Promise.all([refund(order.id), refund(order.id), refund(order.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(sent.filter((m) => m.to === who)).toHaveLength(1);
    expect((await refund(order.id)).status).toBe(409);
  });

  it('only refund-due orders qualify; unknown ids are 404', async () => {
    const customerId = (await t.c.customers.findOrCreateByChannel('web', '919700000003', 'Web')).id;
    const unpaid = await t.c.orders.create({ customerId, channel: 'web', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 1 }] });
    expect((await refund(unpaid.id)).status).toBe(409);
    const paid = await t.c.orders.create({ customerId, channel: 'web', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 1 }] });
    await signedRazorpayWebhook(t.app, paidLinkEvent((await t.c.payments.linkForOrder(paid.id)).providerRef, 1500), { eventId: 'evt_rf_paid' });
    expect((await t.c.orders.get(paid.id))!.paymentStatus).toBe('PAID');
    expect((await refund(paid.id)).status).toBe(409);
    expect((await refund('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await refund('not-a-uuid')).status).toBe(404);
  });

  it('is staff-only', async () => {
    const order = await refundDueOrder('919700000004');
    expect((await refund(order.id, await t.token('viewer'))).status).toBe(403);
    expect((await request(t.app).post(`/api/orders/${order.id}/refunded`).send({})).status).toBe(401);
    expect((await t.c.orders.get(order.id))!.paymentStatus).toBe('REFUND_DUE');
  });

  it('a refunded order can no longer be paid or flagged again, and the public page reports it', async () => {
    const order = await refundDueOrder('919700000005');
    await refund(order.id);
    await expect(t.c.payments.linkForOrder(order.id)).rejects.toMatchObject({ status: 409 });
    const view = await request(t.app).get(`/api/public/orders/${order.publicToken}`);
    expect(view.body).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
    expect(view.body).not.toHaveProperty('paymentUrl');
    expect((await request(t.app).post(`/api/public/orders/${order.publicToken}/payment-link`).send({})).status).toBe(409);
  });

  it('chat customers see the refunded state of their own order', async () => {
    const who = '919700000006';
    const order = await refundDueOrder(who);
    await refund(order.id);
    const reply = await t.c.bot.handle({ channel: 'whatsapp', from: who, text: `order:${order.number}`, action: `order:${order.number}`, senderName: 'R' });
    expect(reply.text).toMatch(/refunded/i);
  });
});
