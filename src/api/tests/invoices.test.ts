import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { InvoiceService, financialYear } from '../src/services/invoices.js';

let t: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>; let staff: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const GST = { legalName: 'Corner Shop Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune', stateCode: '27', invoicePrefix: 'INV', pricesIncludeTax: true };

beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff');
  ids = await seedCatalog(t, staff);
  await request(t.app).patch(`/api/products/${ids.tee.id}`).set(h(staff)).send({ hsnCode: '610910', gstRateBp: 1200 });   // ₹15.00 incl. 12 %
  await request(t.app).patch(`/api/products/${ids.mug.id}`).set(h(staff)).send({ hsnCode: '691110', gstRateBp: 1800 });   // ₹8.00 incl. 18 %
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 1000 }, null);
  await t.c.stock.receive({ productId: ids.mug.id, warehouseId: ids.main.id, quantity: 1000 }, null);
  await t.c.settings.update({ currency: 'INR', defaultWarehouseId: ids.main.id, gst: GST });
});
afterAll(async () => { await t.close(); });

let n = 0;
async function order(opts: { buyer?: { gstin?: string; stateCode?: string }; qty?: number; confirm?: boolean } = {}) {
  const customer = (await request(t.app).post('/api/customers').set(h(staff)).send({ name: `Buyer ${++n}`, ...opts.buyer })).body.id as string;
  const o = await t.c.orders.create({ customerId: customer, channel: 'manual', items: [{ productId: ids.tee.id, quantity: opts.qty ?? 2 }, { productId: ids.mug.id, quantity: 1 }] });
  if (opts.confirm !== false) await t.c.orders.confirm(o.id, ids.main.id, null);
  return o;
}
const invoiceOf = async (orderId: string) => (await t.pool.query('SELECT * FROM invoices WHERE order_id = $1', [orderId])).rows[0];
const waitForInvoice = async (orderId: string) => { for (let i = 0; i < 50; i++) { const r = await invoiceOf(orderId); if (r) return r; await new Promise((res) => setTimeout(res, 20)); } return undefined; };

describe('financialYear (India: 1 April – 31 March, Asia/Kolkata)', () => {
  it('switches at midnight IST on 1 April, not at UTC midnight', () => {
    expect(financialYear(new Date('2027-03-31T18:29:59Z'))).toBe('2026-27'); // 23:59:59 IST on 31 Mar
    expect(financialYear(new Date('2027-03-31T18:30:00Z'))).toBe('2027-28'); // 00:00:00 IST on 1 Apr
    expect(financialYear(new Date('2026-04-01T00:00:00+05:30'))).toBe('2026-27');
    expect(financialYear(new Date('2026-03-31T23:59:59+05:30'))).toBe('2025-26');
    expect(financialYear(new Date('2026-12-31T12:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2099-06-01T00:00:00Z'))).toBe('2099-00');
  });
});

describe('issuing invoices', () => {
  it('issues automatically when an order is confirmed, with a sequential number and exact tax', async () => {
    const o = await order();                       // 2 × 15.00 (12 %) + 1 × 8.00 (18 %) = 38.00
    const row = await waitForInvoice(o.id);
    expect(row.number).toMatch(/^INV\/2026-27\/\d{6}$/);
    expect(row).toMatchObject({ status: 'ISSUED', total_cents: 3800 });
    expect(row.taxable_cents + row.tax_cents).toBe(3800);
    const snap = row.snapshot;
    expect(snap.seller).toMatchObject({ legalName: 'Corner Shop Pvt Ltd', gstin: GST.gstin, stateCode: '27' });
    expect(snap.lines.map((l: { hsnCode: string; gstRateBp: number }) => [l.hsnCode, l.gstRateBp])).toEqual(expect.arrayContaining([['610910', 1200], ['691110', 1800]]));
    expect(snap.totals).toMatchObject({ interState: false, igstCents: 0 });
    expect(snap.totals.cgstCents + snap.totals.sgstCents).toBe(row.tax_cents);
  });

  it('charges IGST to a buyer in another state and records their GSTIN', async () => {
    const o = await order({ buyer: { gstin: '29AAPFU0939F1ZV', stateCode: '29' } });
    const row = await waitForInvoice(o.id);
    expect(row.snapshot.buyer).toMatchObject({ gstin: '29AAPFU0939F1ZV', stateCode: '29' });
    expect(row.snapshot.totals).toMatchObject({ interState: true, cgstCents: 0, sgstCents: 0 });
    expect(row.snapshot.totals.igstCents).toBe(row.tax_cents);
  });

  it('is idempotent: issuing again returns the same invoice and number', async () => {
    const o = await order();
    const first = await t.c.invoices.issue(o.id);
    const again = await t.c.invoices.issue(o.id);
    expect(again.number).toBe(first.number);
    expect(again.id).toBe(first.id);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM invoices WHERE order_id = $1', [o.id])).rows[0].n).toBe(1);
  });

  it('keeps the issued snapshot even if tax rates and the seller profile change later', async () => {
    const o = await order();
    const before = await t.c.invoices.issue(o.id);
    await request(t.app).patch(`/api/products/${ids.tee.id}`).set(h(staff)).send({ gstRateBp: 2800 });
    await t.c.settings.update({ gst: { ...GST, legalName: 'Renamed Ltd' } });
    const after = await t.c.invoices.issue(o.id);
    expect(after.snapshot).toEqual(before.snapshot);
    expect((after.snapshot as { seller: { legalName: string } }).seller.legalName).toBe('Corner Shop Pvt Ltd');
    await request(t.app).patch(`/api/products/${ids.tee.id}`).set(h(staff)).send({ gstRateBp: 1200 });
    await t.c.settings.update({ gst: GST });
  });

  it('refuses unconfirmed orders, and orders when the GST profile is incomplete or prices exclude tax', async () => {
    const pending = await order({ confirm: false });
    await expect(t.c.invoices.issue(pending.id)).rejects.toThrow(/confirmed/i);
    const o = await order({ confirm: false });
    await t.c.settings.update({ gst: { ...GST, gstin: '', stateCode: '' } }); // incomplete BEFORE confirming, so no automatic invoice
    await t.c.orders.confirm(o.id, ids.main.id, null);
    await expect(t.c.invoices.issue(o.id)).rejects.toThrow(/GST profile/i);
    await t.c.settings.update({ gst: { ...GST, pricesIncludeTax: false } });
    await expect(t.c.invoices.issue(o.id)).rejects.toThrow(/include tax/i);
    await t.c.settings.update({ gst: GST });
    expect((await t.c.invoices.issue(o.id)).status).toBe('ISSUED');
  });

  it('does not block confirming an order when invoicing is not set up (no invoice is created)', async () => {
    await t.c.settings.update({ gst: { ...GST, gstin: '', stateCode: '' } });
    const o = await order();
    expect((await t.c.orders.get(o.id))!.status).toBe('CONFIRMED');
    await new Promise((r) => setTimeout(r, 150));
    expect(await invoiceOf(o.id)).toBeUndefined();
    await t.c.settings.update({ gst: GST });
    expect((await t.c.invoices.issue(o.id)).status).toBe('ISSUED'); // can be issued later, once set up
  });
});

describe('numbering', () => {
  it('30 simultaneous confirmations get 30 distinct, gapless numbers', async () => {
    await t.pool.query('TRUNCATE invoices, invoice_counters CASCADE');
    const orders = await Promise.all(Array.from({ length: 30 }, () => order({ confirm: false })));
    await Promise.all(orders.map((o) => t.c.orders.confirm(o.id, ids.main.id, null)));
    for (const o of orders) await waitForInvoice(o.id);
    const { rows } = await t.pool.query("SELECT seq FROM invoices WHERE fy = '2026-27' ORDER BY seq");
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect((await t.pool.query("SELECT last_number FROM invoice_counters WHERE fy = '2026-27'")).rows[0].last_number).toBe(30);
  });

  it('starts again at 1 in a new financial year, and uses the configured prefix', async () => {
    await t.pool.query('TRUNCATE invoices, invoice_counters CASCADE');
    await t.c.settings.update({ gst: { ...GST, invoicePrefix: 'CS' } });
    const a = await order({ confirm: false }); await t.c.orders.confirm(a.id, ids.main.id, null);
    const b = await order({ confirm: false }); await t.c.orders.confirm(b.id, ids.main.id, null);
    await waitForInvoice(b.id);
    await t.pool.query('TRUNCATE invoices, invoice_counters CASCADE');
    const mar = new InvoiceService(t.pool, t.c.settings, () => new Date('2027-03-31T18:29:00Z'));
    const apr = new InvoiceService(t.pool, t.c.settings, () => new Date('2027-03-31T18:31:00Z'));
    const o1 = await order({ confirm: false }); await t.c.orders.confirm(o1.id, ids.main.id, null);
    const o2 = await order({ confirm: false }); await t.c.orders.confirm(o2.id, ids.main.id, null);
    await t.pool.query('TRUNCATE invoices, invoice_counters CASCADE');
    expect((await mar.issue(o1.id)).number).toBe('CS/2026-27/000001');
    expect((await apr.issue(o2.id)).number).toBe('CS/2027-28/000001');
    await t.c.settings.update({ gst: GST });
  });

  it('voids the invoice when the order is cancelled and never reuses its number', async () => {
    await t.pool.query('TRUNCATE invoices, invoice_counters CASCADE');
    const a = await order(); const inv = await waitForInvoice(a.id);
    await t.c.orders.cancel(a.id, null);
    for (let i = 0; i < 50 && (await invoiceOf(a.id)).status !== 'VOID'; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await invoiceOf(a.id)).status).toBe('VOID');
    const b = await order(); const next = await waitForInvoice(b.id);
    expect(next.seq).toBe(inv.seq + 1);
    expect((await invoiceOf(a.id)).number).toBe(inv.number); // the voided number stays on record
  });
});
