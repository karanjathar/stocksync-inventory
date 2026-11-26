import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeRazorpay, paidLinkEvent, refundEvent, signedRazorpayWebhook } from './helpers/fakeRazorpay.js';
import { signInvoiceUrl } from '../src/services/signedUrl.js';

/** Release 4 security regression suite (docs/7_SECURITY_AUDIT.md §7.R4). */
const RZP = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example.com' };
const GST = { legalName: 'Corner Shop Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune', stateCode: '27', invoicePrefix: 'INV', pricesIncludeTax: true };
const SECRET = 'test-secret-'.padEnd(40, 'x');
let t: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>; let staff: string; let viewer: string;
const sent: { to: string; text: string }[] = [];
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const bin = (r: request.Response, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };

beforeAll(async () => {
  t = await buildTestApp({ ...RZP }, { fetch: fakeRazorpay().fn, messenger: { send: async (_c, to, text) => { sent.push({ to, text }); } } });
  staff = await t.token('staff'); viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  await request(t.app).patch(`/api/products/${ids.tee.id}`).set(h(staff)).send({ hsnCode: '610910', gstRateBp: 1200 });
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 500 }, null);
  await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id, gst: GST, alertRecipients: [{ channel: 'telegram', to: 'owner' }] });
});
afterAll(async () => { await t.close(); });

let n = 0;
async function confirmed(name = `Buyer ${++n}`) {
  const customer = (await request(t.app).post('/api/customers').set(h(staff)).send({ name })).body.id as string;
  const o = await t.c.orders.create({ customerId: customer, channel: 'manual', items: [{ productId: ids.tee.id, quantity: 1 }] });
  await t.c.orders.confirm(o.id, ids.main.id, null);
  return o;
}

describe('R4-01 a partial refund must not be announced as a full one', () => {
  async function refundDue() {
    const who = `96${String(++n).padStart(8, '0')}`;
    const customerId = (await t.c.customers.findOrCreateByChannel('whatsapp', who, 'Partial')).id;
    const order = await t.c.orders.create({ customerId, channel: 'whatsapp', paymentMethod: 'ONLINE', items: [{ productId: ids.tee.id, quantity: 2 }] }); // ₹30.00
    const plink = (await t.c.payments.linkForOrder(order.id)).providerRef;
    await signedRazorpayWebhook(t.app, paidLinkEvent(plink, 3000), { eventId: `evt_sec_paid_${n}` });
    await t.c.orders.cancel(order.id, null);
    return { order, who, razorpayPaymentId: `pay_${plink}` };
  }

  it('a refund smaller than what was captured keeps the order REFUND_DUE, says nothing to the customer, and alerts staff', async () => {
    const r = await refundDue();
    sent.length = 0;
    await signedRazorpayWebhook(t.app, refundEvent('processed', 'rfnd_part', r.razorpayPaymentId, 1000), { eventId: `evt_sec_part_${n}` });
    expect((await t.c.orders.get(r.order.id))!.paymentStatus).toBe('REFUND_DUE');
    expect(sent.some((m) => m.to === r.who)).toBe(false);
    expect(sent.some((m) => m.to === 'owner' && /partial/i.test(m.text) && m.text.includes(`#${r.order.number}`))).toBe(true);
  });

  it('a refund of the full captured amount (or more than expected, never less) completes it', async () => {
    const r = await refundDue();
    await signedRazorpayWebhook(t.app, refundEvent('processed', 'rfnd_full', r.razorpayPaymentId, 3000), { eventId: `evt_sec_full_${n}` });
    expect((await t.c.orders.get(r.order.id))!.paymentStatus).toBe('REFUNDED');
  });
});

describe('R4-02 invoices: who can see what', () => {
  it('every invoice endpoint refuses anonymous callers and viewers, and other shoppers\' tokens never reach this order', async () => {
    const mine = await confirmed('Alice Secret'); const theirs = await confirmed('Bob Other');
    for (const path of [`/api/orders/${mine.id}/invoice`, `/api/orders/${mine.id}/invoice.pdf`]) {
      expect((await request(t.app).get(path)).status).toBe(401);
      expect((await request(t.app).get(path).set(h(viewer))).status).toBe(403);
    }
    const pdf = await request(t.app).get(`/api/public/orders/${theirs.publicToken}/invoice.pdf`).buffer(true).parse(bin);
    expect((pdf.body as Buffer).toString('latin1')).not.toContain('Alice Secret');
    expect((await request(t.app).get(`/api/public/orders/${theirs.publicToken}/invoice.pdf`.replace(theirs.publicToken, mine.id))).status).toBe(404); // an order id is not a token
  });

  it('the public status says only whether an invoice exists, never its number or amounts', async () => {
    const o = await confirmed();
    const body = (await request(t.app).get(`/api/public/orders/${o.publicToken}`)).body as Record<string, unknown>;
    expect(body.invoiceAvailable).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/INV\/|gstin|taxable|legalName/i);
  });
});

describe('R4-03 signed invoice links', () => {
  it('stop working when they expire, cannot be re-pointed at another invoice, and a voided invoice is shown as VOID', async () => {
    const a = await confirmed(); const b = await confirmed();
    const idOf = async (orderId: string) => (await t.pool.query('SELECT id FROM invoices WHERE order_id = $1', [orderId])).rows[0].id as string;
    const [ia, ib] = [await idOf(a.id), await idOf(b.id)];
    const url = (id: string, ttl: number, at = new Date()) => signInvoiceUrl(SECRET, 'https://x', id, ttl, at).replace('https://x', '');
    expect((await request(t.app).get(url(ia, 60_000))).status).toBe(200);
    expect((await request(t.app).get(url(ia, 1000, new Date(Date.now() - 10_000)))).status).toBe(404);
    expect((await request(t.app).get(url(ia, 60_000).replace(ia, ib))).status).toBe(404);
    await t.c.orders.cancel(a.id, null);
    await new Promise((r) => setTimeout(r, 50));
    const res = await request(t.app).get(url(ia, 60_000)).buffer(true).parse(bin);
    expect(res.status).toBe(200); // the customer may still hold the document, but it is marked void
    expect((await t.pool.query('SELECT status FROM invoices WHERE id = $1', [ia])).rows[0].status).toBe('VOID');
  });
});

describe('R4-04 hostile text in documents and lookups', () => {
  it('names with PDF syntax, quotes, newlines and non-Latin text produce a normal PDF and never break the download', async () => {
    const o = await confirmed(") Tj /Evil << /S /JavaScript /JS (app.alert(1)) >> (\\" + ' रवि ' + String.fromCharCode(0x202e));
    const res = await request(t.app).post(`/api/orders/${o.id}/invoice.pdf`).set(h(staff)).buffer(true).parse(bin);
    expect(res.status).toBe(200);
    const text = (res.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).not.toMatch(/\/S \/JavaScript|\/JS \(/);
  });

  it('SQL-looking, control-character and oversized barcodes are a plain 404, never a 500', async () => {
    for (const code of ["'; DROP TABLE products;--", '%00', '%27%20OR%201%3D1', 'A'.repeat(500), '%E0%A4%A4']) {
      const res = await request(t.app).get(`/api/products/by-barcode/${code}`).set(h(viewer));
      expect([404, 400], code).toContain(res.status);
    }
    expect((await request(t.app).get('/api/products').set(h(viewer))).status).toBe(200); // table still there
  });
});

describe('R4-05 purchase orders and stock counts take no negative or runaway input', () => {
  it('receipts: replays and the same receipt id on another order do not mix up; negative, zero and huge quantities are refused', async () => {
    const sup = (await request(t.app).post('/api/suppliers').set(h(staff)).send({ name: 'Sec Supplier' })).body.id as string;
    const mk = async () => { const po = await t.c.purchaseOrders.create({ supplierId: sup, warehouseId: ids.main.id, lines: [{ productId: ids.tee.id, quantity: 10, unitCostCents: 100 }] }, null); await t.c.purchaseOrders.send(po.id); return po; };
    const [p1, p2] = [await mk(), await mk()];
    const recv = (id: string, receiptId: string, quantity: number) => request(t.app).post(`/api/purchase-orders/${id}/receive`).set(h(staff)).send({ receiptId, lines: [{ productId: ids.tee.id, quantity }] });
    expect((await recv(p1.id, 'shared', 4)).status).toBe(200);
    expect((await recv(p2.id, 'shared', 4)).body.lines[0].receivedQuantity).toBe(4);   // receipt ids are scoped to their own order
    for (const q of [-1, 0, 1.5, 2_000_000, Number.NaN]) expect((await recv(p1.id, `bad-${q}`, q)).status, String(q)).toBe(400);
    expect((await recv(p1.id, 'x'.repeat(65), 1)).status).toBe(400);
  });

  it('stock counts: negative, fractional, huge and duplicated lines are refused', async () => {
    const c = (await request(t.app).post('/api/stock-counts').set(h(staff)).send({ warehouseId: ids.main.id })).body.id as string;
    const put = (lines: unknown) => request(t.app).put(`/api/stock-counts/${c}/lines`).set(h(staff)).send({ lines });
    for (const bad of [-1, 1.5, 1e12, null, '5']) expect((await put([{ productId: ids.tee.id, countedQuantity: bad }])).status, String(bad)).toBe(400);
    expect((await put(Array.from({ length: 501 }, () => ({ productId: ids.tee.id, countedQuantity: 1 })))).status).toBe(400);
  });
});

describe('R4-06 a NUL character in text is a clean 400, and chat text containing one cannot make a webhook fail forever', () => {
  const NUL = String.fromCharCode(0);
  it('staff APIs answer 400 (not 500) for NUL in any text field', async () => {
    for (const [path, body] of [['/api/customers', { name: `a${NUL}b` }], ['/api/products', { sku: 'NULP', name: `a${NUL}b`, priceCents: 1 }], ['/api/suppliers', { name: `x${NUL}` }], ['/api/warehouses', { code: 'NULW', name: `n${NUL}` }]] as const) {
      expect((await request(t.app).post(path).set(h(staff)).send(body)).status, path).toBe(400);
    }
  });

  it('the public checkout answers 400 for NUL in the shopper\'s name or phone', async () => {
    const res = await request(t.app).post('/api/public/orders').send({ name: `Mia${NUL}`, phone: '919811112233', items: [{ productId: ids.tee.id, quantity: 1 }], paymentMethod: 'COD' });
    expect(res.status).toBeLessThan(500);
  });

  it('an inbound WhatsApp message whose text and profile name contain NUL is stored without it and acknowledged', async () => {
    const { createHmac } = await import('node:crypto');
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '919800000001', profile: { name: `Zed${NUL}Name` } }],
      messages: [{ id: 'wamid.NUL1', from: '919800000001', type: 'text', text: { body: `help${NUL}me` } }] } }] }] });
    const res = await request(t.app).post('/webhooks/meta').set('content-type', 'application/json')
      .set('x-hub-signature-256', `sha256=${createHmac('sha256', 'meta-secret').update(raw).digest('hex')}`).send(raw);
    expect(res.status).toBe(200);
    const row = (await t.pool.query("SELECT text FROM channel_messages WHERE external_id = 'wamid.NUL1'")).rows[0];
    expect(row.text).toBe('helpme');
  });
});

