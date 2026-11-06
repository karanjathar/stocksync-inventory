import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { formatInvoiceNumber } from '../src/services/invoices.js';

let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let admin: string;
let staff: string;
let viewer: string;
let year: number;
let n = 0;

beforeAll(async () => {
  t = await buildTestApp();
  admin = await t.token('admin');
  staff = await t.token('staff');
  viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  const gst = (await request(t.app).post('/api/tax-rates').set(auth(admin)).send({ name: 'GST 18%', rateBp: 1800 })).body.id as string;
  await request(t.app).patch(`/api/products/${ids.tee.id}`).set(auth(staff)).send({ taxRateId: gst });
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 500 }, null);
  await t.c.stock.receive({ productId: ids.mug.id, warehouseId: ids.main.id, quantity: 500 }, null);
  await t.c.settings.update({ businessName: 'Corner Shop', currency: 'INR', defaultWarehouseId: ids.main.id, taxId: '29ABCDE1234F1Z5', businessAddress: '12 MG Road, Bengaluru' });
  year = (await t.pool.query('SELECT extract(year FROM now())::int AS y')).rows[0].y;
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const get = (url: string, tok = staff) => request(t.app).get(url).set(auth(tok));
const customer = () => t.c.customers.findOrCreateByChannel('web', `91980000${String(++n).padStart(4, '0')}`, `Buyer ${n}`);
/** A PENDING order of 2 tees (taxed) and 1 mug. */
async function pending(items = [{ productId: ids.tee.id, quantity: 2 }, { productId: ids.mug.id, quantity: 1 }]) {
  const c = await customer();
  return t.c.orders.create({ customerId: c.id, channel: 'web', items });
}
const confirm = (id: string) => t.c.orders.confirm(id, undefined, null);
const invoiceOf = async (orderId: string) => (await get(`/api/invoices?orderId=${orderId}`)).body[0];

describe('invoice numbers', () => {
  it('formats INV-<year>-<6 digits>', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('INV-2026-000001');
    expect(formatInvoiceNumber(2027, 123456)).toBe('INV-2027-123456');
  });
});

describe('issuing invoices on confirmation (T65)', () => {
  it('creates one invoice with a snapshot of seller, customer, lines and totals', async () => {
    const o = await pending();
    expect(await invoiceOf(o.id)).toBeUndefined(); // nothing until the order is confirmed
    await confirm(o.id);
    const inv = await invoiceOf(o.id);
    expect(inv).toMatchObject({
      status: 'ISSUED', orderId: o.id, orderNumber: o.number, currency: 'INR', inclusive: false,
      subtotalCents: 3800, taxCents: 540, discountCents: 0, totalCents: 4340,
      seller: { businessName: 'Corner Shop', taxId: '29ABCDE1234F1Z5', address: '12 MG Road, Bengaluru' },
      customer: { name: o.customerName },
    });
    expect(inv.number).toMatch(new RegExp(`^INV-${year}-\\d{6}$`));
    expect(inv.lines).toEqual([
      { sku: 'MUG', name: 'Mug', quantity: 1, unitPriceCents: 800, discountCents: 0, netCents: 800, taxRateBp: 0, taxCents: 0, totalCents: 800 },
      { sku: 'TEE', name: 'T-Shirt', quantity: 2, unitPriceCents: 1500, discountCents: 0, netCents: 3000, taxRateBp: 1800, taxCents: 540, totalCents: 3540 },
    ]);
    expect(inv.totalCents).toBe((await t.c.orders.get(o.id))!.totalCents);
  });

  it('does not issue a second invoice when the order is fulfilled', async () => {
    const o = await pending();
    await confirm(o.id);
    await t.c.orders.fulfill(o.id);
    expect((await get(`/api/invoices?orderId=${o.id}`)).body).toHaveLength(1);
  });

  it('keeps the numbers gapless: a failed confirmation uses no number', async () => {
    const before = (await t.pool.query("SELECT coalesce(max(last), 0)::int AS n FROM invoice_counters WHERE year = $1", [year])).rows[0].n;
    const ok1 = await pending();
    await confirm(ok1.id);
    const tooMany = await pending([{ productId: ids.mug.id, quantity: 100_000 }]);
    await expect(confirm(tooMany.id)).rejects.toMatchObject({ status: 409 });
    expect(await invoiceOf(tooMany.id)).toBeUndefined();
    const ok2 = await pending();
    await confirm(ok2.id);
    const a = (await invoiceOf(ok1.id)).number as string;
    const b = (await invoiceOf(ok2.id)).number as string;
    expect(a).toBe(formatInvoiceNumber(year, before + 1));
    expect(b).toBe(formatInvoiceNumber(year, before + 2));
  });

  it('gives 10 simultaneous confirmations 10 distinct consecutive numbers', async () => {
    const before = (await t.pool.query("SELECT last FROM invoice_counters WHERE year = $1", [year])).rows[0].last as number;
    const orders = await Promise.all(Array.from({ length: 10 }, () => pending()));
    await Promise.all(orders.map((o) => confirm(o.id)));
    const numbers = (await Promise.all(orders.map(async (o) => (await invoiceOf(o.id)).number as string))).sort();
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => formatInvoiceNumber(year, before + 1 + i)));
  });

  it('keeps every invoice unique: no two share a number', async () => {
    const dup = await t.pool.query('SELECT number FROM invoices GROUP BY number HAVING count(*) > 1');
    expect(dup.rowCount).toBe(0);
  });
});

describe('immutability (T65)', () => {
  it('later changes to the shop, customer, product or tax rate never alter an issued invoice', async () => {
    const o = await pending();
    await confirm(o.id);
    const before = await invoiceOf(o.id);
    await t.c.settings.update({ businessName: 'Renamed Shop', taxId: 'CHANGED' });
    await request(t.app).patch(`/api/products/${ids.tee.id}`).set(auth(staff)).send({ priceCents: 9999, name: 'Renamed Tee' });
    await t.pool.query("UPDATE customers SET name = 'Someone Else' WHERE id = $1", [o.customerId]);
    const after = await invoiceOf(o.id);
    expect(after).toEqual(before);
    await request(t.app).patch(`/api/products/${ids.tee.id}`).set(auth(staff)).send({ priceCents: 1500, name: 'T-Shirt' });
    await t.c.settings.update({ businessName: 'Corner Shop', taxId: '29ABCDE1234F1Z5' });
  });

  it('the database refuses to edit or delete an invoice', async () => {
    const o = await pending();
    await confirm(o.id);
    const inv = await invoiceOf(o.id);
    await expect(t.pool.query('UPDATE invoices SET total_cents = 1 WHERE id = $1', [inv.id])).rejects.toThrow(/immutable/i);
    await expect(t.pool.query("UPDATE invoices SET number = 'INV-HACK' WHERE id = $1", [inv.id])).rejects.toThrow(/immutable/i);
    await expect(t.pool.query("UPDATE invoices SET lines = '[]'::jsonb WHERE id = $1", [inv.id])).rejects.toThrow(/immutable/i);
    await expect(t.pool.query('DELETE FROM invoices WHERE id = $1', [inv.id])).rejects.toThrow(/cannot be deleted/i);
    expect((await invoiceOf(o.id)).totalCents).toBe(inv.totalCents);
  });

  it('exposes no way to edit invoices over the API', async () => {
    const o = await pending();
    await confirm(o.id);
    const inv = await invoiceOf(o.id);
    for (const method of ['patch', 'put', 'delete'] as const) {
      expect((await request(t.app)[method](`/api/invoices/${inv.id}`).set(auth(admin)).send({ totalCents: 1 })).status).toBe(404);
    }
  });
});

describe('cancelling (T65)', () => {
  it('voids the invoice of a confirmed order but keeps it, and restores nothing else', async () => {
    const o = await pending();
    await confirm(o.id);
    const issued = await invoiceOf(o.id);
    await t.c.orders.cancel(o.id, null);
    const voided = await invoiceOf(o.id);
    expect(voided).toMatchObject({ id: issued.id, number: issued.number, status: 'VOID', totalCents: issued.totalCents });
    expect(voided.voidedAt).toBeTruthy();
  });

  it('a pending order that is cancelled never gets an invoice', async () => {
    const o = await pending();
    await t.c.orders.cancel(o.id, null);
    expect(await invoiceOf(o.id)).toBeUndefined();
  });

  it('a void invoice can never become issued again', async () => {
    const o = await pending();
    await confirm(o.id);
    const inv = await invoiceOf(o.id);
    await t.c.orders.cancel(o.id, null);
    await expect(t.pool.query("UPDATE invoices SET status = 'ISSUED', voided_at = NULL WHERE id = $1", [inv.id])).rejects.toThrow(/immutable/i);
  });
});

describe('invoice API (T65)', () => {
  it('lists newest first with filters, and reads one by id', async () => {
    const o = await pending();
    await confirm(o.id);
    const all = (await get('/api/invoices')).body as { number: string; status: string }[];
    expect(all.length).toBeGreaterThan(5);
    expect(all[0]!.number > all[1]!.number).toBe(true);
    expect((await get('/api/invoices?status=VOID')).body.every((i: { status: string }) => i.status === 'VOID')).toBe(true);
    expect((await get(`/api/invoices?year=${year}`)).body.length).toBe(all.length);
    expect((await get(`/api/invoices?year=${year - 1}`)).body).toHaveLength(0);
    const inv = await invoiceOf(o.id);
    expect((await get(`/api/invoices/${inv.id}`)).body.number).toBe(inv.number);
    expect((await get('/api/invoices?status=NOPE')).status).toBe(400);
    expect((await get('/api/invoices/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('/api/invoices/not-a-uuid')).status).toBe(404);
  });

  it('is staff-only', async () => {
    expect((await get('/api/invoices', viewer)).status).toBe(403);
    expect((await request(t.app).get('/api/invoices')).status).toBe(401);
  });
});
