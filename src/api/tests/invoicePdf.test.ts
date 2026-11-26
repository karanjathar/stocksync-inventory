import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { amountInWords } from '../src/services/amountInWords.js';
import { renderInvoicePdf, pdfSafe } from '../src/services/invoicePdf.js';
import { pdfText } from './helpers/pdfText.js';
import type { Invoice } from '../src/services/invoices.js';

describe('amountInWords (Indian numbering)', () => {
  it.each([
    [0, 'Zero Rupees Only'], [100, 'One Rupee Only'], [11800, 'One Hundred Eighteen Rupees Only'],
    [12345600, 'One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees Only'],
    [1_00_00_000_00, 'One Crore Rupees Only'], [250_00_00_000_00, 'Two Hundred Fifty Crore Rupees Only'],
    [150, 'One Rupee and Fifty Paise Only'], [5, 'Five Paise Only'], [101, 'One Rupee and One Paisa Only'],
    [2100_00, 'Two Thousand One Hundred Rupees Only'], [19, 'Nineteen Paise Only'],
  ])('%i paise', (cents, words) => expect(amountInWords(cents)).toBe(words));
  it('rejects negative or fractional amounts', () => { expect(() => amountInWords(-1)).toThrow(); expect(() => amountInWords(1.5)).toThrow(); });
});

describe('pdfSafe', () => {
  it('keeps Latin-1 text, replaces everything a standard PDF font cannot show, and drops control characters', () => {
    expect(pdfSafe('Café Ltd.')).toBe('Café Ltd.');
    expect(pdfSafe('रवि Kumar ₹5')).toBe('??? Kumar ?5');
    expect(pdfSafe('a\u0000b\nc\td')).toBe('ab c d');
    expect(pdfSafe('x'.repeat(500), 20)).toHaveLength(20);
  });
});

const snapshot = (over: { buyer?: Partial<Invoice['snapshot']['buyer']>; interState?: boolean; lines?: number; seller?: Partial<Invoice['snapshot']['seller']> } = {}): Invoice => {
  const interState = over.interState ?? false;
  const lines = Array.from({ length: over.lines ?? 2 }, (_, i) => ({ productId: `p${i}`, sku: `SKU${i}`, name: `Item ${i}`, hsnCode: '610910', gstRateBp: 1200, quantity: 2, unitPriceCents: 11200, grossCents: 22400, taxableCents: 20000, taxCents: 2400 }));
  const taxable = lines.length * 20000; const tax = lines.length * 2400;
  const totals = { interState, taxableCents: taxable, taxCents: tax, totalCents: taxable + tax, cgstCents: interState ? 0 : tax / 2, sgstCents: interState ? 0 : tax / 2, igstCents: interState ? tax : 0 };
  return { id: 'i1', orderId: 'o1', number: 'INV/2026-27/000042', fy: '2026-27', seq: 42, status: 'ISSUED', issuedAt: '2026-11-26T09:30:00.000Z', taxableCents: taxable, taxCents: tax, totalCents: taxable + tax,
    snapshot: { number: 'INV/2026-27/000042', fy: '2026-27', issuedAt: '2026-11-26T09:30:00.000Z', currency: 'INR', pricesIncludeTax: true,
      seller: { legalName: 'Corner Shop Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune', stateCode: '27', ...over.seller },
      buyer: { name: 'Asha Traders', gstin: '29AAPFU0939F1ZV', stateCode: interState ? '29' : '27', ...over.buyer },
      order: { number: 17, createdAt: '2026-11-26T09:00:00.000Z', channel: 'whatsapp' }, lines, totals } };
};

describe('renderInvoicePdf', () => {
  it('prints the legal details, per-line HSN and tax, CGST+SGST and the amount in words', async () => {
    const buf = await renderInvoicePdf(snapshot(), { compress: false });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(buf);
    for (const expected of ['TAX INVOICE', 'INV/2026-27/000042', 'Corner Shop Pvt Ltd', '27AAPFU0939F1ZV', '12 MG Road, Pune', 'Asha Traders', '29AAPFU0939F1ZV', '610910', 'CGST', 'SGST',
      '₹200.00', '₹224.00', '₹400.00', '₹24.00', '₹448.00', 'Four Hundred Forty Eight Rupees Only', '26-11-2026', 'Order #17']) expect(text, expected).toContain(expected);
    expect(text).not.toContain('IGST');
  });

  it('prints the rupee sign and Hindi names with an embedded font instead of question marks', async () => {
    const buf = await renderInvoicePdf(snapshot({ buyer: { name: 'कमला पटेल Traders' }, seller: { legalName: 'दुकान Pvt Ltd', address: 'पुणे' } }), { compress: false });
    const text = pdfText(buf);
    for (const expected of ['कमला पटेल Traders', 'दुकान Pvt Ltd', 'पुणे', '₹448.00']) expect(text, expected).toContain(expected);
    expect(text).not.toContain('?');
    const raw = buf.toString('latin1');
    expect(raw).toMatch(/NotoSans-Regular/);
    expect(raw).toMatch(/NotoSansDevanagari-Regular/);
  });

  it('keeps the file small by embedding only the glyphs it uses', async () => {
    expect((await renderInvoicePdf(snapshot({ buyer: { name: 'रवि' } }))).length).toBeLessThan(60_000);
  });

  it('still replaces characters neither font has (emoji, other scripts) with a question mark', async () => {
    const text = pdfText(await renderInvoicePdf(snapshot({ buyer: { name: 'Ann 😀 தமிழ்' } }), { compress: false }));
    expect(text).toContain('Ann ? ');
    expect(text).not.toContain('😀');
  });

  it('shows IGST for an inter-state sale', async () => {
    const text = pdfText(await renderInvoicePdf(snapshot({ interState: true }), { compress: false }));
    expect(text).toContain('IGST');
    expect(text).not.toContain('CGST');
  });

  it('marks a void invoice and survives hostile text', async () => {
    const hostile = ') Tj /Evil << /S /JavaScript >> (\\ ) \u0000 रवि ₹';
    const inv = { ...snapshot({ buyer: { name: hostile } }), status: 'VOID' as const };
    const buf = await renderInvoicePdf(inv, { compress: false });
    expect(buf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    const text = pdfText(buf);
    expect(text).toContain('VOID');
    expect(text).toContain(') Tj /Evil << /S /JavaScript >> (\\ )'); // shown as plain text, never interpreted as PDF syntax
    expect(buf.toString('latin1')).not.toMatch(/\/JavaScript/);       // the hostile name appears only inside a hex string
  });

  it('paginates a long invoice', async () => {
    const buf = await renderInvoicePdf(snapshot({ lines: 120 }), { compress: false });
    const pages = (buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
    expect(pages).toBeGreaterThan(2);
    expect(pdfText(buf)).toContain('Item 119');
  });
});

describe('invoice download endpoints', () => {
  let t: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>; let staff: string;
  const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const GST = { legalName: 'Corner Shop Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune', stateCode: '27', invoicePrefix: 'INV', pricesIncludeTax: true };
  beforeAll(async () => {
    t = await buildTestApp();
    staff = await t.token('staff');
    ids = await seedCatalog(t, staff);
    await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 100 }, null);
    await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id, gst: GST });
  });
  afterAll(async () => { await t.close(); });
  const mk = async (name: string, confirm = true) => {
    const customer = (await request(t.app).post('/api/customers').set(h(staff)).send({ name })).body.id as string;
    const o = await t.c.orders.create({ customerId: customer, channel: 'manual', items: [{ productId: ids.tee.id, quantity: 1 }] });
    if (confirm) await t.c.orders.confirm(o.id, ids.main.id, null);
    return o;
  };
  const binary = (res: request.Response) => (res.body as Buffer);

  it('staff download a PDF with safe headers; JSON invoice is available too', async () => {
    const o = await mk('Download Buyer');
    const res = await request(t.app).post(`/api/orders/${o.id}/invoice.pdf`).set(h(staff)).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['content-disposition']).toMatch(/inline; filename="invoice-INV-2026-27-\d{6}\.pdf"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(binary(res).subarray(0, 5).toString()).toBe('%PDF-');
    const json = await request(t.app).post(`/api/orders/${o.id}/invoice`).set(h(staff));
    expect(json.body).toMatchObject({ orderId: o.id, status: 'ISSUED' });
  });

  it('is staff-only, 409 before confirmation, 404 for unknown orders', async () => {
    const o = await mk('Early Buyer', false);
    expect((await request(t.app).post(`/api/orders/${o.id}/invoice.pdf`).set(h(staff))).status).toBe(409);
    expect((await request(t.app).post(`/api/orders/${o.id}/invoice.pdf`).set(h(await t.token('viewer')))).status).toBe(403);
    expect((await request(t.app).post(`/api/orders/${o.id}/invoice.pdf`)).status).toBe(401);
    expect((await request(t.app).get('/api/orders/00000000-0000-4000-8000-000000000000/invoice.pdf').set(h(staff))).status).toBe(404);
  });

  it('the public token route serves only that order\'s invoice, only once confirmed', async () => {
    const mine = await mk('Alice Public'); const other = await mk('Bob Private'); const unconfirmed = await mk('Carol Pending', false);
    const get = (token: string) => request(t.app).get(`/api/public/orders/${token}/invoice.pdf`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    const ok = await get(mine.publicToken);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['cache-control']).toContain('no-store');
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    expect(binary(ok).toString('latin1')).not.toContain('Bob Private');
    expect((await request(t.app).get(`/api/public/orders/${mine.publicToken}`)).body.invoiceAvailable).toBe(true);
    expect((await request(t.app).get(`/api/public/orders/${unconfirmed.publicToken}`)).body.invoiceAvailable).toBe(false);
    expect((await get(unconfirmed.publicToken)).status).toBe(404);
    expect((await get('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('not-a-token')).status).toBe(404);
    expect(other.publicToken).not.toBe(mine.publicToken);
  });
});
