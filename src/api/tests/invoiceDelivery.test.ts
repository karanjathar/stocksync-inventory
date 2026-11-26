import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { signInvoiceUrl, verifyInvoiceSignature } from '../src/services/signedUrl.js';

const SECRET = 'test-secret-'.padEnd(40, 'x');
const GST = { legalName: 'Corner Shop Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune', stateCode: '27', invoicePrefix: 'INV', pricesIncludeTax: true };

describe('signed invoice URLs', () => {
  const now = new Date('2026-11-26T10:00:00Z');
  const id = '11111111-1111-4111-8111-111111111111';
  const parts = (url: string) => { const u = new URL(url); return { id: u.pathname.split('/')[4]!, exp: u.searchParams.get('exp')!, sig: u.searchParams.get('sig')! }; };

  it('verifies a fresh link and rejects tampering, expiry and other invoices', () => {
    const url = signInvoiceUrl(SECRET, 'https://shop.example.com', id, 3_600_000, now);
    expect(url).toMatch(/^https:\/\/shop\.example\.com\/api\/public\/invoices\/[0-9a-f-]{36}\/download\.pdf\?exp=\d+&sig=[0-9a-f]{64}$/);
    const p = parts(url);
    expect(verifyInvoiceSignature(SECRET, p.id, p.exp, p.sig, now)).toBe(true);
    expect(verifyInvoiceSignature(SECRET, p.id, p.exp, p.sig, new Date(now.getTime() + 3_599_000))).toBe(true);
    expect(verifyInvoiceSignature(SECRET, p.id, p.exp, p.sig, new Date(now.getTime() + 3_601_000))).toBe(false);                 // expired
    expect(verifyInvoiceSignature(SECRET, '22222222-2222-4222-8222-222222222222', p.exp, p.sig, now)).toBe(false);               // another invoice
    expect(verifyInvoiceSignature(SECRET, p.id, String(Number(p.exp) + 1000), p.sig, now)).toBe(false);                           // extended expiry
    expect(verifyInvoiceSignature(SECRET, p.id, p.exp, p.sig.replace(/.$/, p.sig.endsWith('0') ? '1' : '0'), now)).toBe(false);   // flipped bit
    expect(verifyInvoiceSignature('another-secret-'.padEnd(40, 'y'), p.id, p.exp, p.sig, now)).toBe(false);                     // other key
    for (const junk of ['', 'zz', 'a'.repeat(64) + 'x', 'a'.repeat(63)]) expect(verifyInvoiceSignature(SECRET, p.id, p.exp, junk, now)).toBe(false);
    expect(verifyInvoiceSignature(SECRET, p.id, 'abc', p.sig, now)).toBe(false);
  });
});

describe('delivering the invoice', () => {
  let t: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>; let staff: string;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let failWith: number | null = null;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (failWith) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: failWith });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.INV' }], result: { message_id: 5 } }), { status: 200 });
  }) as typeof fetch;
  const h = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    t = await buildTestApp({ WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '99', TELEGRAM_BOT_TOKEN: 'tg', PUBLIC_BASE_URL: 'https://shop.example.com' }, { fetch: fakeFetch });
    staff = await t.token('staff');
    ids = await seedCatalog(t, staff);
    await request(t.app).patch(`/api/products/${ids.tee.id}`).set(h(staff)).send({ hsnCode: '610910', gstRateBp: 1200 });
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 500 }, null);
    await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id, gst: GST });
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { calls.length = 0; failWith = null; await t.pool.query('TRUNCATE jobs, channel_messages'); });

  let n = 0;
  const confirmedOrder = async (channel: 'whatsapp' | 'telegram' | 'web', openWindow = true) => {
    const who = `9198${String(++n).padStart(8, '0')}`;
    const customer = await t.c.customers.findOrCreateByChannel(channel, who, 'Asha');
    if (openWindow && channel === 'whatsapp') await t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text) VALUES ('whatsapp','in',$1,'hi')", [who]);
    const o = await t.c.orders.create({ customerId: customer.id, channel, items: [{ productId: ids.tee.id, quantity: 2 }] });
    await t.c.orders.confirm(o.id, ids.main.id, null);
    return { order: o, who };
  };
  const documentCall = () => calls.find((c) => c.body.type === 'document');

  it('sends a WhatsApp customer the invoice as a document with a signed, expiring link', async () => {
    const { order } = await confirmedOrder('whatsapp');
    const doc = documentCall()!;
    expect(doc).toBeTruthy();
    const d = doc.body.document as { link: string; filename: string; caption: string };
    expect(d.link).toMatch(/^https:\/\/shop\.example\.com\/api\/public\/invoices\/[0-9a-f-]{36}\/download\.pdf\?exp=\d+&sig=[0-9a-f]{64}$/);
    expect(d.filename).toMatch(/^invoice-INV-2026-27-\d{6}\.pdf$/);
    expect(d.caption).toContain(`#${order.number}`);
    const invoice = (await t.pool.query('SELECT id FROM invoices WHERE order_id = $1', [order.id])).rows[0];
    expect(d.link).toContain(invoice.id);
    // the link works once, from outside, without a login
    const path = d.link.replace('https://shop.example.com', '');
    const res = await request(t.app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('refuses a tampered, expired or foreign download link', async () => {
    const { order } = await confirmedOrder('whatsapp');
    const inv = (await t.pool.query('SELECT id FROM invoices WHERE order_id = $1', [order.id])).rows[0].id as string;
    const other = await confirmedOrder('whatsapp');
    const otherInv = (await t.pool.query('SELECT id FROM invoices WHERE order_id = $1', [other.order.id])).rows[0].id as string;
    const good = new URL(signInvoiceUrl(SECRET, 'https://x', inv, 3_600_000));
    const path = (id: string, q: string) => `/api/public/invoices/${id}/download.pdf?${q}`;
    expect((await request(t.app).get(path(inv, good.searchParams.toString()))).status).toBe(200);
    expect((await request(t.app).get(path(otherInv, good.searchParams.toString()))).status).toBe(404);          // signature belongs to another invoice
    expect((await request(t.app).get(path(inv, `exp=${good.searchParams.get('exp')}&sig=${'0'.repeat(64)}`))).status).toBe(404);
    const expired = new URL(signInvoiceUrl(SECRET, 'https://x', inv, 1000, new Date(Date.now() - 3_600_000)));
    expect((await request(t.app).get(path(inv, expired.searchParams.toString()))).status).toBe(404);
    expect((await request(t.app).get(path(inv, ''))).status).toBe(404);
    expect((await request(t.app).get(path('not-a-uuid', good.searchParams.toString()))).status).toBe(404);
  });

  it('outside the 24-hour window the mapped invoice_ready template carries the link', async () => {
    await t.c.settings.update({ whatsappTemplates: { invoice_ready: { name: 'invoice_ready_v1', language: 'en', params: ['customerName', 'orderNumber', 'invoiceLink'] } } });
    const { order } = await confirmedOrder('whatsapp', false);
    expect(documentCall()).toBeUndefined();
    const tpl = calls.find((c) => c.body.type === 'template')!;
    const params = ((tpl.body.template as { components: { parameters: { text: string }[] }[] }).components[0]!.parameters).map((p) => p.text);
    expect(params[0]).toBe('Asha');
    expect(params[1]).toBe(String(order.number));
    expect(params[2]).toContain('/api/public/invoices/');
  });

  it('other chat channels get the link as text; web and manual customers get nothing', async () => {
    await confirmedOrder('telegram');
    const tg = calls.find((c) => String(c.body.text ?? '').includes('/api/public/invoices/'));
    expect(tg).toBeTruthy();
    calls.length = 0;
    await confirmedOrder('web');
    expect(calls).toHaveLength(0);
  });

  it('a provider outage keeps the message queued for retry instead of losing it', async () => {
    failWith = 503;
    await confirmedOrder('whatsapp');
    const row = (await t.pool.query("SELECT status, event FROM channel_messages WHERE direction = 'out' AND payload->>'kind' = 'document'")).rows[0];
    expect(row).toMatchObject({ status: 'queued', event: 'invoice_ready' });
  });

  it('sends nothing when no invoice could be issued (GST profile not set up)', async () => {
    await t.c.settings.update({ gst: { ...GST, gstin: '', stateCode: '' } });
    await confirmedOrder('whatsapp');
    expect(calls.some((c) => c.body.type === 'document' || JSON.stringify(c.body).includes('/api/public/invoices/'))).toBe(false); // only the ordinary confirmation went out
    await t.c.settings.update({ gst: GST });
  });
});
