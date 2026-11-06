import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay, paidLinkEvent, signedRazorpayWebhook } from './helpers/fakeRazorpay.js';
import { formatCreditNoteNumber } from '../src/services/returns.js';

const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let admin: string;
let staff: string;
let viewer: string;
let odd: string; // 3.33 product with 5% tax, to exercise rounding
const sent: { channel: string; to: string; text: string }[] = [];
let n = 0;
let rid = 0;

beforeAll(async () => {
  t = await buildTestApp(RZP, { fetch: fakeRazorpay().fn, messenger: { send: async (channel, to, text) => { sent.push({ channel, to, text }); } } });
  admin = await t.token('admin');
  staff = await t.token('staff');
  viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  const gst18 = (await post('/api/tax-rates', { name: 'GST 18%', rateBp: 1800 }, admin)).body.id as string;
  const gst5 = (await post('/api/tax-rates', { name: 'GST 5%', rateBp: 500 }, admin)).body.id as string;
  await patch(`/api/products/${ids.tee.id}`, { taxRateId: gst18 });
  odd = (await post('/api/products', { sku: 'ODD', name: 'Odd Item', priceCents: 333, taxRateId: gst5 })).body.id as string;
  for (const p of [ids.tee.id, ids.mug.id, odd]) await t.c.stock.receive({ productId: p, warehouseId: ids.main.id, quantity: 1000 }, null);
  await t.c.settings.update({ businessName: 'Corner Shop', currency: 'INR', defaultWarehouseId: ids.main.id, alertRecipients: [{ channel: 'telegram', to: 'staff-chat' }] });
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const post = (url: string, body: unknown, tok = staff) => request(t.app).post(url).set(auth(tok)).send(body as object);
const patch = (url: string, body: unknown, tok = staff) => request(t.app).patch(url).set(auth(tok)).send(body as object);
const get = (url: string, tok = staff) => request(t.app).get(url).set(auth(tok));
const qtyIn = async (productId: string, warehouseId: string) =>
  (await t.pool.query('SELECT quantity FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [productId, warehouseId])).rows[0]?.quantity as number ?? 0;

async function confirmed(items = [{ productId: ids.tee.id, quantity: 3 }, { productId: ids.mug.id, quantity: 1 }], channel: 'web' | 'whatsapp' = 'web') {
  const c = await t.c.customers.findOrCreateByChannel(channel, `91960000${String(++n).padStart(4, '0')}`, `Buyer ${n}`);
  const o = await t.c.orders.create({ customerId: c.id, channel, items });
  await t.c.orders.confirm(o.id, undefined, null);
  return (await t.c.orders.get(o.id))!;
}
async function lineId(orderId: string, sku: string): Promise<string> {
  return (await t.pool.query('SELECT oi.id FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 AND p.sku = $2', [orderId, sku])).rows[0].id as string;
}
const ret = async (orderId: string, lines: { sku: string; quantity: number }[], over: Record<string, unknown> = {}, tok = staff) =>
  post(`/api/orders/${orderId}/returns`, {
    requestId: `ret-${++rid}`, warehouseId: ids.main.id,
    lines: await Promise.all(lines.map(async (l) => ({ orderItemId: await lineId(orderId, l.sku), quantity: l.quantity }))), ...over,
  }, tok);

describe('credit note numbers', () => {
  it('formats CN-<year>-<6 digits>', () => { expect(formatCreditNoteNumber(2026, 7)).toBe('CN-2026-000007'); });
});

describe('creating a return (T67)', () => {
  it('restocks through the ledger into the chosen warehouse and issues a credit note with tax reversed', async () => {
    const o = await confirmed(); // 3 tees (5310 incl. 18%) + 1 mug (800) from MAIN
    const shopBefore = await qtyIn(ids.tee.id, ids.shop.id);
    const res = await ret(o.id, [{ sku: 'TEE', quantity: 1 }], { warehouseId: ids.shop.id, reason: 'Wrong size' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ orderId: o.id, creditTotalCents: 1770, creditTaxCents: 270, creditSubtotalCents: 1500, reason: 'Wrong size', refundStatus: 'NOT_REQUIRED' });
    expect(res.body.items).toEqual([expect.objectContaining({ sku: 'TEE', quantity: 1, creditTotalCents: 1770, creditTaxCents: 270 })]);
    expect(res.body.creditNote.number).toMatch(/^CN-\d{4}-\d{6}$/);
    expect(await qtyIn(ids.tee.id, ids.shop.id)).toBe(shopBefore + 1);
    const ledger = await t.pool.query('SELECT type, quantity_delta FROM stock_movements WHERE reference = $1', [`RET-${res.body.number}`]);
    expect(ledger.rows).toEqual([{ type: 'IN', quantity_delta: 1 }]);
    const cn = (await get(`/api/credit-notes/${res.body.creditNote.id}`)).body;
    expect(cn).toMatchObject({ salesReturnId: res.body.id, orderNumber: o.number, totalCents: 1770, taxCents: 270, subtotalCents: 1500, currency: 'INR', reason: 'Wrong size' });
    expect(cn.invoiceNumber).toMatch(/^INV-/);
    expect(cn.lines).toEqual([expect.objectContaining({ sku: 'TEE', quantity: 1, totalCents: 1770, taxCents: 270, netCents: 1500, taxRateBp: 1800 })]);
  });

  it('credits add up to exactly the line value over several partial returns (no rounding drift)', async () => {
    const o = await confirmed([{ productId: odd, quantity: 3 }]); // 3 x 3.33 = 9.99 + 5% = 0.50 (0.4995) -> total 1049
    expect(o.totalCents).toBe(1049);
    const credits = [];
    for (let i = 0; i < 3; i++) credits.push((await ret(o.id, [{ sku: 'ODD', quantity: 1 }])).body);
    expect(credits.reduce((s, c) => s + c.creditTotalCents, 0)).toBe(1049);
    expect(credits.reduce((s, c) => s + c.creditTaxCents, 0)).toBe(50);
    expect(credits.every((c) => c.creditSubtotalCents === c.creditTotalCents - c.creditTaxCents)).toBe(true);
    expect((await ret(o.id, [{ sku: 'ODD', quantity: 1 }])).status).toBe(409); // everything is already back
  });

  it('refuses to return more than was bought, in one go or across returns', async () => {
    const o = await confirmed();
    expect((await ret(o.id, [{ sku: 'TEE', quantity: 4 }])).status).toBe(409);
    expect((await ret(o.id, [{ sku: 'TEE', quantity: 2 }])).status).toBe(201);
    const over = await ret(o.id, [{ sku: 'TEE', quantity: 2 }]);
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/only 1 can still be returned/i);
    expect((await ret(o.id, [{ sku: 'TEE', quantity: 1 }, { sku: 'MUG', quantity: 1 }])).status).toBe(201);
  });

  it('works for confirmed and fulfilled orders only', async () => {
    const c = await t.c.customers.findOrCreateByChannel('web', '919600009999', 'Pending Pat');
    const pending = await t.c.orders.create({ customerId: c.id, channel: 'web', items: [{ productId: ids.mug.id, quantity: 1 }] });
    expect((await ret(pending.id, [{ sku: 'MUG', quantity: 1 }])).status).toBe(409);
    const done = await confirmed();
    await t.c.orders.fulfill(done.id);
    expect((await ret(done.id, [{ sku: 'MUG', quantity: 1 }])).status).toBe(201);
    const cancelled = await confirmed();
    await t.c.orders.cancel(cancelled.id, null);
    expect((await ret(cancelled.id, [{ sku: 'MUG', quantity: 1 }])).status).toBe(409);
  });

  it('is idempotent per request id, and refuses a reused id with different content', async () => {
    const o = await confirmed();
    const before = await qtyIn(ids.tee.id, ids.main.id);
    const first = await ret(o.id, [{ sku: 'TEE', quantity: 1 }], { requestId: 'same-id' });
    const again = await ret(o.id, [{ sku: 'TEE', quantity: 1 }], { requestId: 'same-id' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await qtyIn(ids.tee.id, ids.main.id)).toBe(before + 1);
    expect((await ret(o.id, [{ sku: 'TEE', quantity: 2 }], { requestId: 'same-id' })).status).toBe(409);
    const other = await confirmed();
    expect((await ret(other.id, [{ sku: 'TEE', quantity: 1 }], { requestId: 'same-id' })).status).toBe(409);
  });

  it('six simultaneous identical submits create one return and restock once', async () => {
    const o = await confirmed();
    const before = await qtyIn(ids.tee.id, ids.main.id);
    const body = { requestId: 'dbl-click', warehouseId: ids.main.id, lines: [{ orderItemId: await lineId(o.id, 'TEE'), quantity: 2 }] };
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(`/api/orders/${o.id}/returns`, body)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(5);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await qtyIn(ids.tee.id, ids.main.id)).toBe(before + 2);
  });

  it('eight simultaneous full returns with different ids: exactly one wins', async () => {
    const o = await confirmed();
    const before = await qtyIn(ids.tee.id, ids.main.id);
    const rs = await Promise.all(Array.from({ length: 8 }, () => ret(o.id, [{ sku: 'TEE', quantity: 3 }])));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await qtyIn(ids.tee.id, ids.main.id)).toBe(before + 3);
  });

  it('validates input and checks that everything exists', async () => {
    const o = await confirmed();
    const other = await confirmed();
    const tee = await lineId(o.id, 'TEE');
    const base = { requestId: 'v-1', warehouseId: ids.main.id, lines: [{ orderItemId: tee, quantity: 1 }] };
    expect((await post(`/api/orders/${o.id}/returns`, { ...base, lines: [] })).status).toBe(400);
    expect((await post(`/api/orders/${o.id}/returns`, { ...base, lines: [{ orderItemId: tee, quantity: 0 }] })).status).toBe(400);
    expect((await post(`/api/orders/${o.id}/returns`, { ...base, requestId: '' })).status).toBe(400);
    expect((await post(`/api/orders/${o.id}/returns`, { ...base, lines: [{ orderItemId: tee, quantity: 1 }, { orderItemId: tee, quantity: 1 }] })).status).toBe(400);
    expect((await post(`/api/orders/${o.id}/returns`, { ...base, warehouseId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await post(`/api/orders/${o.id}/returns`, { ...base, lines: [{ orderItemId: await lineId(other.id, 'TEE'), quantity: 1 }] })).status).toBe(404);
    expect((await post('/api/orders/00000000-0000-4000-8000-000000000000/returns', base)).status).toBe(404);
    expect((await post(`/api/orders/${o.id}/returns`, base, viewer)).status).toBe(403);
    expect((await request(t.app).post(`/api/orders/${o.id}/returns`).send(base)).status).toBe(401);
    // nothing was created by any of the failures
    expect((await get(`/api/returns?orderId=${o.id}`)).body).toHaveLength(0);
  });
});

describe('refunds for paid online orders (T67)', () => {
  async function paidOnline() {
    const c = await t.c.customers.findOrCreateByChannel('whatsapp', `91960001${String(++n).padStart(4, '0')}`, 'Pay Pal');
    const o = await t.c.orders.create({ customerId: c.id, channel: 'whatsapp', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 2 }] });
    const link = (await t.c.payments.linkForOrder(o.id)).providerRef;
    await signedRazorpayWebhook(t.app, paidLinkEvent(link, o.totalCents), { eventId: `evt_ret_${o.number}` });
    const fresh = (await t.c.orders.get(o.id))!;
    expect(fresh).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
    return { order: fresh, who: c.channelUserId! };
  }

  it('flags the credit amount as refund due, alerts staff, and staff mark it refunded exactly once', async () => {
    const { order, who } = await paidOnline(); // 2 x 1500 + 18% = 3540
    sent.length = 0;
    const res = await ret(order.id, [{ sku: 'TEE', quantity: 1 }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ refundStatus: 'REFUND_DUE', refundCents: 1770, creditTotalCents: 1770 });
    expect(sent.some((m) => m.to === 'staff-chat' && /refund/i.test(m.text) && /17\.70/.test(m.text) && m.text.includes(`#${order.number}`))).toBe(true);
    expect((await t.c.orders.get(order.id))!.paymentStatus).toBe('PAID'); // the order itself stays paid
    sent.length = 0;
    const marks = await Promise.all([post(`/api/returns/${res.body.id}/refunded`, {}), post(`/api/returns/${res.body.id}/refunded`, {}), post(`/api/returns/${res.body.id}/refunded`, {})]);
    expect(marks.map((m) => m.status).sort()).toEqual([200, 409, 409]);
    expect((await get(`/api/returns/${res.body.id}`)).body.refundStatus).toBe('REFUNDED');
    expect(sent.filter((m) => m.to === who)).toHaveLength(1);
    expect(sent.find((m) => m.to === who)!.text).toMatch(/refund.*17\.70|17\.70.*refund/i);
    expect((await post(`/api/returns/${res.body.id}/refunded`, {})).status).toBe(409);
    expect((await post(`/api/returns/${res.body.id}/refunded`, {}, viewer)).status).toBe(403);
  });

  it('a second return on the same paid order is flagged separately', async () => {
    const { order } = await paidOnline();
    const a = await ret(order.id, [{ sku: 'TEE', quantity: 1 }]);
    await post(`/api/returns/${a.body.id}/refunded`, {});
    const b = await ret(order.id, [{ sku: 'TEE', quantity: 1 }]);
    expect(b.body.refundStatus).toBe('REFUND_DUE');
    expect(a.body.creditTotalCents + b.body.creditTotalCents).toBe(3540);
  });

  it('cash on delivery and unpaid orders need no refund, and cannot be marked refunded', async () => {
    const o = await confirmed();
    const r = await ret(o.id, [{ sku: 'MUG', quantity: 1 }]);
    expect(r.body).toMatchObject({ refundStatus: 'NOT_REQUIRED', refundCents: 0 });
    expect((await post(`/api/returns/${r.body.id}/refunded`, {})).status).toBe(409);
  });
});

describe('credit notes (T67)', () => {
  it('are immutable, numbered without gaps, and printable with escaped text', async () => {
    const o = await confirmed();
    const r = await ret(o.id, [{ sku: 'MUG', quantity: 1 }], { reason: '<img src=x onerror=alert(1)>' });
    const id = r.body.creditNote.id as string;
    await expect(t.pool.query('UPDATE credit_notes SET total_cents = 1 WHERE id = $1', [id])).rejects.toThrow(/immutable/i);
    await expect(t.pool.query('DELETE FROM credit_notes WHERE id = $1', [id])).rejects.toThrow(/cannot be deleted/i);
    const html = (await get(`/api/credit-notes/${id}/print`)).text;
    expect(html).toContain(r.body.creditNote.number);
    expect(html).toContain('CREDIT NOTE');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect((await get(`/api/credit-notes/${id}/print`, viewer)).status).toBe(403);
    const numbers = (await get('/api/credit-notes')).body.map((c: { number: string }) => c.number).sort() as string[];
    const seq = numbers.map((x) => Number(x.slice(-6)));
    expect(seq).toEqual(Array.from({ length: seq.length }, (_, i) => i + 1));
  });

  it('lists returns and credit notes for staff only', async () => {
    expect((await get('/api/returns')).body.length).toBeGreaterThan(3);
    expect((await get('/api/returns?refundStatus=REFUND_DUE')).body.every((x: { refundStatus: string }) => x.refundStatus === 'REFUND_DUE')).toBe(true);
    expect((await get('/api/returns?refundStatus=NOPE')).status).toBe(400);
    for (const url of ['/api/returns', '/api/credit-notes']) {
      expect((await get(url, viewer)).status).toBe(403);
      expect((await request(t.app).get(url)).status).toBe(401);
    }
    expect((await get('/api/returns/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('/api/credit-notes/not-a-uuid')).status).toBe(404);
  });
});
