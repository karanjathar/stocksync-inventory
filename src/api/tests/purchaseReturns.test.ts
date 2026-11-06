import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { formatDebitNoteNumber } from '../src/services/purchaseReturns.js';

let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let staff: string;
let viewer: string;
let acme: string;
let rid = 0;

beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff');
  viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  acme = (await post('/api/suppliers', { name: 'Acme Wholesale', email: 'sales@acme.test' })).body.id;
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const post = (url: string, body: unknown, tok = staff) => request(t.app).post(url).set(auth(tok)).send(body as object);
const get = (url: string, tok = staff) => request(t.app).get(url).set(auth(tok));
const stockOf = async (productId: string, warehouseId = ids.main.id) =>
  (await t.pool.query('SELECT quantity FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [productId, warehouseId])).rows[0]?.quantity as number ?? 0;

/** A sent PO of 10 tees @ 9.00, fully received into MAIN. */
async function received(receive = 10) {
  const po = (await post('/api/purchase-orders', { supplierId: acme, warehouseId: ids.main.id, items: [{ productId: ids.tee.id, quantity: 10, unitCostCents: 900 }] })).body;
  await post(`/api/purchase-orders/${po.id}/send`, {});
  if (receive) await post(`/api/purchase-orders/${po.id}/receive`, { lines: [{ itemId: po.items[0].id, quantity: receive }] });
  return { id: po.id as string, itemId: po.items[0].id as string, number: po.number as number };
}
const ret = (po: { id: string; itemId: string }, quantity: number, over: Record<string, unknown> = {}, tok = staff) =>
  post(`/api/purchase-orders/${po.id}/returns`, { requestId: `pr-${++rid}`, warehouseId: ids.main.id, lines: [{ itemId: po.itemId, quantity }], ...over }, tok);
const bill = async (poId: string, amountCents?: number) => (await post('/api/bills', { purchaseOrderId: poId, ...(amountCents ? { amountCents } : {}) })).body;
const owed = async (billId: string) => { const b = (await get(`/api/bills/${billId}`)).body; return b.totalCents - b.paidCents - b.debitCents; };

describe('debit note numbers', () => {
  it('formats DN-<year>-<6 digits>', () => { expect(formatDebitNoteNumber(2026, 4)).toBe('DN-2026-000004'); });
});

describe('returning goods to a supplier (T68)', () => {
  it('issues stock through the ledger and creates a debit note for the cost of the goods', async () => {
    const po = await received();
    const before = await stockOf(ids.tee.id);
    const res = await ret(po, 3, { reason: 'Damaged in transit' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ purchaseOrderId: po.id, supplierId: acme, debitTotalCents: 2700, appliedCents: 0, unappliedCents: 0, reason: 'Damaged in transit' });
    expect(res.body.debitNoteNumber).toMatch(/^DN-\d{4}-\d{6}$/);
    expect(res.body.items).toEqual([expect.objectContaining({ sku: 'TEE', quantity: 3, debitCents: 2700 })]);
    expect(await stockOf(ids.tee.id)).toBe(before - 3);
    const ledger = await t.pool.query('SELECT type, quantity_delta FROM stock_movements WHERE reference = $1', [`PRET-${res.body.number}`]);
    expect(ledger.rows).toEqual([{ type: 'OUT', quantity_delta: -3 }]);
  });

  it('only goods that were received and not already returned can go back', async () => {
    const po = await received(4);
    expect((await ret(po, 5)).status).toBe(409); // only 4 arrived
    expect((await ret(po, 3)).status).toBe(201);
    const over = await ret(po, 2);
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/only 1 can still be returned/i);
    expect((await ret(po, 1)).status).toBe(201);
  });

  it('cannot take stock below zero, and then changes nothing', async () => {
    const po = await received();
    const have = await stockOf(ids.tee.id);
    await t.c.stock.issue({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: have - 2 }, null); // sold meanwhile: only 2 left
    const res = await ret(po, 3);
    expect(res.status).toBe(409);
    expect(await stockOf(ids.tee.id)).toBe(2);
    expect((await get(`/api/purchase-returns?purchaseOrderId=${po.id}`)).body).toHaveLength(0);
  });

  it('refuses a purchase order with nothing received', async () => {
    const sent = await received(0);
    expect((await ret(sent, 1)).status).toBe(409);
  });
});

describe('effect on supplier bills (T68)', () => {
  it('reduces what is owed on a billed order, and the payables report follows', async () => {
    const po = await received();
    const b = await bill(po.id); // 9000
    const res = await ret(po, 3);
    expect(res.body).toMatchObject({ debitTotalCents: 2700, appliedCents: 2700, unappliedCents: 0 });
    const after = (await get(`/api/bills/${b.id}`)).body;
    expect(after).toMatchObject({ totalCents: 9000, paidCents: 0, debitCents: 2700, status: 'PARTIAL' });
    expect(await owed(b.id)).toBe(6300);
    const open = (await get('/api/reports/payables')).body.suppliers.find((s: { supplierId: string }) => s.supplierId === acme).openCents as number;
    expect(open).toBeGreaterThanOrEqual(6300);
    // paying more than what is left is refused; paying exactly what is left settles it
    expect((await post(`/api/bills/${b.id}/payments`, { requestId: `pp-${++rid}`, amountCents: 6301, method: 'bank' })).status).toBe(409);
    const paid = await post(`/api/bills/${b.id}/payments`, { requestId: `pp-${++rid}`, amountCents: 6300, method: 'bank' });
    expect(paid.body.status).toBe('PAID');
  });

  it('a bill that is fully debited is settled, and a bill with a debit cannot be voided', async () => {
    const po = await received(3);
    const b = await bill(po.id); // 2700
    await ret(po, 3);
    expect((await get(`/api/bills/${b.id}`)).body).toMatchObject({ status: 'PAID', debitCents: 2700 });
    const po2 = await received();
    const b2 = await bill(po2.id);
    await ret(po2, 1);
    expect((await post(`/api/bills/${b2.id}/void`, {})).status).toBe(409);
  });

  it('a bill that was already paid leaves money owed BY the supplier (unapplied)', async () => {
    const po = await received();
    const b = await bill(po.id);
    await post(`/api/bills/${b.id}/payments`, { requestId: `pp-${++rid}`, amountCents: 9000, method: 'bank' });
    const res = await ret(po, 3);
    expect(res.body).toMatchObject({ debitTotalCents: 2700, appliedCents: 0, unappliedCents: 2700 });
    expect((await get(`/api/bills/${b.id}`)).body).toMatchObject({ paidCents: 9000, debitCents: 0, status: 'PAID' });
  });

  it('goods that were not billed yet simply lower what can still be billed', async () => {
    const po = await received();
    const res = await ret(po, 3); // nothing billed yet
    expect(res.body).toMatchObject({ appliedCents: 0, unappliedCents: 0 });
    const b = await bill(po.id);
    expect(b.totalCents).toBe(6300); // 7 kept x 9.00
  });

  it('applies only the billed value that exceeds what was kept (partly billed order)', async () => {
    const po = await received();
    const b = await bill(po.id, 5000);
    const first = await ret(po, 3); // kept 6300 >= billed 5000: no debit needed
    expect(first.body).toMatchObject({ appliedCents: 0, unappliedCents: 0 });
    expect((await bill(po.id)).totalCents).toBe(1300); // the rest of the kept goods can still be billed...
    const second = await ret(po, 4); // kept falls to 3 x 9.00 = 2700, billed 6300: the 3600 over is debited
    expect(second.body.appliedCents).toBeGreaterThan(0);
    const total = (await get(`/api/bills?supplierId=${acme}`)).body
      .filter((x: { purchaseOrderId: string }) => x.purchaseOrderId === po.id)
      .reduce((n: number, x: { totalCents: number; paidCents: number; debitCents: number }) => n + x.totalCents - x.paidCents - x.debitCents, 0);
    expect(total).toBe(2700); // owed = value of the 3 tees that were kept
    void b;
  });
});

describe('idempotency and concurrency (T68)', () => {
  it('a repeated request id returns the same return once; a different body with that id is refused', async () => {
    const po = await received();
    const before = await stockOf(ids.tee.id);
    const first = await ret(po, 2, { requestId: 'same-pr' });
    const again = await ret(po, 2, { requestId: 'same-pr' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await stockOf(ids.tee.id)).toBe(before - 2);
    expect((await ret(po, 3, { requestId: 'same-pr' })).status).toBe(409);
  });

  it('eight simultaneous full returns: exactly one wins and stock goes down once', async () => {
    const po = await received();
    const before = await stockOf(ids.tee.id);
    const rs = await Promise.all(Array.from({ length: 8 }, () => ret(po, 10)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await stockOf(ids.tee.id)).toBe(before - 10);
  });
});

describe('validation and permissions (T68)', () => {
  it('rejects bad input and unknown things, and is staff-only', async () => {
    const po = await received();
    const other = await received();
    const base = { requestId: 'v-pr', warehouseId: ids.main.id, lines: [{ itemId: po.itemId, quantity: 1 }] };
    const send = (b: object, tok = staff) => post(`/api/purchase-orders/${po.id}/returns`, b, tok);
    expect((await send({ ...base, lines: [] })).status).toBe(400);
    expect((await send({ ...base, lines: [{ itemId: po.itemId, quantity: 0 }] })).status).toBe(400);
    expect((await send({ ...base, requestId: '' })).status).toBe(400);
    expect((await send({ ...base, lines: [{ itemId: po.itemId, quantity: 1 }, { itemId: po.itemId, quantity: 1 }] })).status).toBe(400);
    expect((await send({ ...base, warehouseId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await send({ ...base, lines: [{ itemId: other.itemId, quantity: 1 }] })).status).toBe(404);
    expect((await post('/api/purchase-orders/00000000-0000-4000-8000-000000000000/returns', base)).status).toBe(404);
    expect((await send(base, viewer)).status).toBe(403);
    expect((await request(t.app).post(`/api/purchase-orders/${po.id}/returns`).send(base)).status).toBe(401);
    for (const url of ['/api/purchase-returns']) {
      expect((await get(url, viewer)).status).toBe(403);
      expect((await request(t.app).get(url)).status).toBe(401);
    }
    expect((await get('/api/purchase-returns/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('/api/purchase-returns/nope')).status).toBe(404);
  });

  it('lists and reads returns', async () => {
    const po = await received();
    const made = await ret(po, 1);
    const list = (await get(`/api/purchase-returns?purchaseOrderId=${po.id}`)).body;
    expect(list).toHaveLength(1);
    expect((await get(`/api/purchase-returns/${made.body.id}`)).body.debitNoteNumber).toBe(made.body.debitNoteNumber);
  });
});

describe('debit notes (T68)', () => {
  it('are immutable and print with escaped text', async () => {
    await t.pool.query("UPDATE suppliers SET name = $1 WHERE id = $2", ['<script>alert(1)</script> Traders', acme]);
    const po = await received();
    const made = await ret(po, 1, { reason: '<img src=x onerror=alert(1)>' });
    await expect(t.pool.query('UPDATE purchase_returns SET debit_total_cents = 1 WHERE id = $1', [made.body.id])).rejects.toThrow(/immutable/i);
    await expect(t.pool.query('DELETE FROM purchase_returns WHERE id = $1', [made.body.id])).rejects.toThrow(/cannot be deleted/i);
    const html = (await get(`/api/purchase-returns/${made.body.id}/print`)).text;
    expect(html).toContain(made.body.debitNoteNumber);
    expect(html).toContain('DEBIT NOTE');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Traders');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<script>alert|<img src=x/);
    expect((await get(`/api/purchase-returns/${made.body.id}/print`, viewer)).status).toBe(403);
    await t.pool.query("UPDATE suppliers SET name = 'Acme Wholesale' WHERE id = $1", [acme]);
  });

  it('numbers are consecutive without gaps', async () => {
    const nums = (await get('/api/purchase-returns')).body.map((r: { debitNoteNumber: string }) => Number(r.debitNoteNumber.slice(-6))).sort((a: number, b: number) => a - b) as number[];
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
  });
});
