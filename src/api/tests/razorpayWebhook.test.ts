import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay } from './helpers/fakeRazorpay.js';
import type { Order, RealtimeEvent } from '../src/domain/types.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let customerId: string;
const alerts: string[] = [];
const events: RealtimeEvent[] = [];

beforeAll(async () => {
  t = await buildTestApp(RZP, {
    fetch: fakeRazorpay().fn,
    messenger: { send: async (_c, to, text) => { alerts.push(`${to}: ${text}`); } },
  });
  ids = await seedCatalog(t, await t.token('staff')); // TEE 1500
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 5 }, null);
  await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id, alertRecipients: [{ channel: 'whatsapp', to: 'STAFF' }] });
  customerId = (await t.c.customers.findOrCreateByChannel('whatsapp', '919811110000', 'Asha')).id;
  t.c.events.subscribe((e) => events.push(e));
});
afterAll(async () => { await t.close(); });

async function onlineOrder(qty: number): Promise<{ order: Order; plink: string }> {
  const order = await t.c.orders.create({ customerId, channel: 'whatsapp', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: qty }] });
  const p = await t.c.payments.linkForOrder(order.id);
  return { order, plink: p.providerRef };
}

function paidEvent(plink: string, amount: number, extra: Record<string, unknown> = {}) {
  return {
    entity: 'event', event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: plink, status: 'paid', amount, amount_paid: amount, reference_id: 'x' } },
      payment: { entity: { id: `pay_${plink}`, amount, status: 'captured', method: 'upi' } },
    },
    created_at: 1793999999, ...extra,
  };
}

function send(body: unknown, opts: { eventId?: string; secret?: string; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const sig = opts.signature ?? createHmac('sha256', opts.secret ?? 'whsec').update(raw).digest('hex');
  const req = request(t.app).post('/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', sig);
  return (opts.eventId ? req.set('x-razorpay-event-id', opts.eventId) : req).send(raw);
}

const stockOf = async () => (await t.c.stock.levels({ productId: ids.tee.id }))[0]!.quantity;

describe('POST /webhooks/razorpay (T36)', () => {
  it('rejects bad signatures without changing anything', async () => {
    const { order, plink } = await onlineOrder(1);
    expect((await send(paidEvent(plink, 1500), { secret: 'wrong' })).status).toBe(401);
    expect((await send(paidEvent(plink, 1500), { signature: '' })).status).toBe(401);
    expect((await t.c.orders.get(order.id))!.paymentStatus).toBe('UNPAID');
    await t.c.orders.cancel(order.id, null);
  });

  it('paid → payment and order PAID, auto-confirmed from the default warehouse, event published', async () => {
    const { order, plink } = await onlineOrder(2);
    const before = await stockOf();
    expect((await send(paidEvent(plink, 3000), { eventId: 'evt_paid_1' })).status).toBe(200);
    const o = (await t.c.orders.get(order.id))!;
    expect(o).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED', warehouseId: ids.main.id });
    expect(await stockOf()).toBe(before - 2);
    const pay = await t.pool.query('SELECT status, provider_payment_id FROM payments WHERE provider_ref = $1', [plink]);
    expect(pay.rows[0]).toEqual({ status: 'PAID', provider_payment_id: `pay_${plink}` });
    expect(events).toContainEqual({ type: 'payment.updated', orderId: order.id, number: order.number, paymentStatus: 'PAID' });
  });

  it('replayed events (same event id) are ignored — no double stock deduction', async () => {
    const { order, plink } = await onlineOrder(1);
    const before = await stockOf();
    await send(paidEvent(plink, 1500), { eventId: 'evt_replay' });
    expect((await send(paidEvent(plink, 1500), { eventId: 'evt_replay' })).status).toBe(200);
    // a re-delivery with a NEW event id for an already-paid link is also harmless
    await send(paidEvent(plink, 1500), { eventId: 'evt_replay_2' });
    expect(await stockOf()).toBe(before - 1);
    expect((await t.c.orders.get(order.id))!.status).toBe('CONFIRMED');
  });

  it('paid but out of stock → REFUND_DUE, order stays pending, staff alerted', async () => {
    const { order, plink } = await onlineOrder(2); // stock now 2 left
    await t.c.stock.issue({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 2 }, null); // sold elsewhere
    alerts.length = 0;
    expect((await send(paidEvent(plink, 3000), { eventId: 'evt_oos' })).status).toBe(200);
    expect((await t.c.orders.get(order.id))!).toMatchObject({ status: 'PENDING', paymentStatus: 'REFUND_DUE' });
    expect(alerts.some((a) => a.startsWith('STAFF:') && a.includes(`#${order.number}`) && /refund/i.test(a))).toBe(true);
    expect(events).toContainEqual({ type: 'payment.updated', orderId: order.id, number: order.number, paymentStatus: 'REFUND_DUE' });
  });

  it('amount mismatch or payment on a cancelled order → REFUND_DUE', async () => {
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 10 }, null);
    const a = await onlineOrder(1);
    await send(paidEvent(a.plink, 100), { eventId: 'evt_mismatch' });
    expect((await t.c.orders.get(a.order.id))!.paymentStatus).toBe('REFUND_DUE');
    const b = await onlineOrder(1);
    await t.c.orders.cancel(b.order.id, null);
    await send(paidEvent(b.plink, 1500), { eventId: 'evt_cancelled' });
    expect((await t.c.orders.get(b.order.id))!).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUND_DUE' });
  });

  it('expired / cancelled link events update the payment; unknown links and events are acknowledged', async () => {
    const { plink } = await onlineOrder(1);
    await send({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: plink, status: 'expired' } } } }, { eventId: 'evt_exp' });
    expect((await t.pool.query('SELECT status FROM payments WHERE provider_ref = $1', [plink])).rows[0].status).toBe('EXPIRED');
    expect((await send(paidEvent('plink_unknown', 100), { eventId: 'evt_unknown' })).status).toBe(200);
    expect((await send({ event: 'refund.created', payload: {} }, { eventId: 'evt_other' })).status).toBe(200);
    expect((await send({ nonsense: true }, { eventId: 'evt_garbage' })).status).toBe(200);
  });

  it('a second payment (customer paid two links of one order) is recorded, flagged for refund, and never double-confirms', async () => {
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 10 }, null);
    const order = await t.c.orders.create({ customerId, channel: 'whatsapp', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 1 }] });
    const first = await t.c.payments.linkForOrder(order.id);
    await t.pool.query("UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = $1", [first.id]);
    const second = await t.c.payments.linkForOrder(order.id); // replaces the stale link
    expect(second.id).not.toBe(first.id);

    const before = await stockOf();
    await send(paidEvent(first.providerRef, 1500), { eventId: 'evt_dup_1' });   // customer pays the OLD link…
    expect(await t.c.orders.get(order.id)).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
    alerts.length = 0;
    expect((await send(paidEvent(second.providerRef, 1500), { eventId: 'evt_dup_2' })).status).toBe(200); // …and the NEW one too

    const rows = (await t.pool.query('SELECT provider_ref, status FROM payments WHERE order_id = $1 ORDER BY created_at', [order.id])).rows;
    expect(rows.map((r) => r.status)).toEqual(['PAID', 'PAID']);
    expect(await t.c.orders.get(order.id)).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' }); // order unaffected
    expect(await stockOf()).toBe(before - 1);                                                             // stock deducted once
    const staff = alerts.filter((a) => a.startsWith('STAFF:'));
    expect(staff).toHaveLength(1);
    expect(staff[0]).toContain(`#${order.number}`);
    expect(staff[0]).toContain(`pay_${second.providerRef}`);
    expect(staff[0]).toMatch(/duplicate/i);
    expect(alerts.some((a) => a.startsWith('919811110000:') && /second payment/i.test(a))).toBe(true);

    await send(paidEvent(second.providerRef, 1500), { eventId: 'evt_dup_3' }); // re-delivery under a new event id
    expect(alerts.filter((a) => a.startsWith('STAFF:'))).toHaveLength(1);
  });

  it('paid with no default warehouse → stays PENDING/PAID for a manual confirm, never REFUND_DUE (T50)', async () => {
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 10 }, null);
    await t.c.settings.update({ defaultWarehouseId: null });
    try {
      const { order, plink } = await onlineOrder(1);
      alerts.length = 0;
      expect((await send(paidEvent(plink, 1500), { eventId: 'evt_nowh' })).status).toBe(200);
      expect(await t.c.orders.get(order.id)).toMatchObject({ status: 'PENDING', paymentStatus: 'PAID' });
      const staff = alerts.filter((a) => a.startsWith('STAFF:'));
      expect(staff).toHaveLength(1);
      expect(staff[0]).toContain(`#${order.number}`);
      expect(staff[0]).toMatch(/default warehouse/i);
      expect(staff[0]).not.toMatch(/refund/i);
      const customerMsgs = alerts.filter((a) => a.startsWith('919811110000:'));
      expect(customerMsgs).toHaveLength(1);
      expect(customerMsgs[0]).toMatch(/payment .*received/i);
      expect(customerMsgs[0]).not.toMatch(/refund/i);
      await t.c.orders.confirm(order.id, ids.main.id, null); // staff confirm by hand
      expect(await t.c.orders.get(order.id)).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
    } finally {
      await t.c.settings.update({ defaultWarehouseId: ids.main.id });
    }
  });

  it('a crash while auto-confirming is recovered by Razorpay retrying the same event', async () => {
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 10 }, null);
    const { order, plink } = await onlineOrder(1);
    const spy = vi.spyOn(t.c.orders, 'confirm').mockRejectedValueOnce(new Error('connection reset'));
    try {
      expect((await send(paidEvent(plink, 1500), { eventId: 'evt_crash' })).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    // payment is recorded, order not yet confirmed; the event id was released so the retry is processed
    expect(await t.c.orders.get(order.id)).toMatchObject({ status: 'PENDING', paymentStatus: 'PAID' });
    const before = await stockOf();
    expect((await send(paidEvent(plink, 1500), { eventId: 'evt_crash' })).status).toBe(200);
    expect(await t.c.orders.get(order.id)).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
    expect(await stockOf()).toBe(before - 1);
    await send(paidEvent(plink, 1500), { eventId: 'evt_crash' }); // and a further replay changes nothing
    expect(await stockOf()).toBe(before - 1);
  });

  it('is 503 when Razorpay is not configured', async () => {
    const { createContainer } = await import('../src/container.js');
    const { createApp } = await import('../src/http/app.js');
    const { loadEnv } = await import('../src/config/env.js');
    const { TEST_ENV } = await import('./helpers/app.js');
    const app = createApp(createContainer({ env: loadEnv({ ...TEST_ENV }), pool: t.pool }));
    expect((await request(app).post('/webhooks/razorpay').set('content-type', 'application/json').send('{}')).status).toBe(503);
  });
});
