import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';

let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let staff: string;
let viewer: string;
let acme: string;
let globex: string;

beforeAll(async () => {
  t = await buildTestApp();
  staff = await t.token('staff');
  viewer = await t.token('viewer');
  ids = await seedCatalog(t, staff);
  acme = (await request(t.app).post('/api/suppliers').set(auth(staff)).send({ name: 'Acme' })).body.id;
  globex = (await request(t.app).post('/api/suppliers').set(auth(staff)).send({ name: 'Globex' })).body.id;
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const post = (url: string, body: unknown, tok = staff) => request(t.app).post(url).set(auth(tok)).send(body as object);
const get = (url: string, tok = staff) => request(t.app).get(url).set(auth(tok));
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** PO of 10 tees @ 900 and 4 mugs @ 300 (total 10,200), sent and optionally received in part. */
async function po(supplierId = acme, receive: { tee?: number; mug?: number } = {}) {
  const made = (await post('/api/purchase-orders', { supplierId, warehouseId: ids.main.id,
    items: [{ productId: ids.tee.id, quantity: 10, unitCostCents: 900 }, { productId: ids.mug.id, quantity: 4, unitCostCents: 300 }] })).body;
  await post(`/api/purchase-orders/${made.id}/send`, {});
  const lines = [] as { itemId: string; quantity: number }[];
  for (const [key, productId] of [['tee', ids.tee.id], ['mug', ids.mug.id]] as const) {
    const q = receive[key];
    if (q) lines.push({ itemId: made.items.find((i: { productId: string }) => i.productId === productId).id, quantity: q });
  }
  if (lines.length) await post(`/api/purchase-orders/${made.id}/receive`, { lines });
  return made as { id: string };
}
let rid = 0;
const pay = (billId: string, amountCents: number, requestId = `req-${++rid}`, tok = staff) => post(`/api/bills/${billId}/payments`, { requestId, amountCents, method: 'bank' }, tok);

describe('vendor bills (T61)', () => {
  it('bills the received value of a purchase order with a due date', async () => {
    const p = await po(acme, { tee: 10, mug: 4 });
    const res = await post('/api/bills', { purchaseOrderId: p.id, dueDate: daysFromNow(15) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'UNPAID', supplierId: acme, purchaseOrderId: p.id, totalCents: 10 * 900 + 4 * 300, paidCents: 0 });
    expect(res.body.dueDate).toBe(daysFromNow(15));
    expect(res.body.payments).toEqual([]);
  });

  it('defaults the due date to 30 days and bills only what was received, never twice', async () => {
    const p = await po(acme, { tee: 4 });
    const first = await post('/api/bills', { purchaseOrderId: p.id });
    expect(first.body.totalCents).toBe(3600);
    expect(first.body.dueDate).toBe(daysFromNow(30));
    expect((await post('/api/bills', { purchaseOrderId: p.id })).status).toBe(409); // nothing new to bill
    await post(`/api/purchase-orders/${p.id}/receive`, { lines: [{ itemId: (await get(`/api/purchase-orders/${p.id}`)).body.items.find((i: { productId: string }) => i.productId === ids.mug.id).id, quantity: 2 }] });
    const second = await post('/api/bills', { purchaseOrderId: p.id });
    expect(second.status).toBe(201);
    expect(second.body.totalCents).toBe(600);
  });

  it('refuses to bill an order with nothing received, and an unknown order', async () => {
    const p = await po();
    expect((await post('/api/bills', { purchaseOrderId: p.id })).status).toBe(409);
    expect((await post('/api/bills', { purchaseOrderId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('accepts a smaller amount than the received value but never a bigger one', async () => {
    const p = await po(acme, { tee: 10 });
    expect((await post('/api/bills', { purchaseOrderId: p.id, amountCents: 9001 })).status).toBe(409);
    const ok = await post('/api/bills', { purchaseOrderId: p.id, amountCents: 5000 });
    expect(ok.body.totalCents).toBe(5000);
  });

  it('supports a standalone bill for a supplier (no purchase order)', async () => {
    const res = await post('/api/bills', { supplierId: globex, amountCents: 2500, dueDate: daysFromNow(7) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ supplierId: globex, purchaseOrderId: null, totalCents: 2500 });
    expect((await post('/api/bills', { supplierId: globex })).status).toBe(400); // amount required without a PO
    expect((await post('/api/bills', { supplierId: '00000000-0000-4000-8000-000000000000', amountCents: 5 })).status).toBe(404);
    expect((await post('/api/bills', { supplierId: globex, amountCents: 0 })).status).toBe(400);
    expect((await post('/api/bills', { supplierId: globex, amountCents: 5, dueDate: '2026-13-45' })).status).toBe(400);
  });

  it('records payments: PARTIAL then PAID, and rejects overpayment', async () => {
    const bill = (await post('/api/bills', { supplierId: globex, amountCents: 1000, dueDate: daysFromNow(5) })).body;
    const part = await pay(bill.id, 400);
    expect(part.status).toBe(200);
    expect(part.body).toMatchObject({ status: 'PARTIAL', paidCents: 400 });
    expect((await pay(bill.id, 601)).status).toBe(409);
    const done = await pay(bill.id, 600);
    expect(done.body).toMatchObject({ status: 'PAID', paidCents: 1000 });
    expect(done.body.payments).toHaveLength(2);
    expect((await pay(bill.id, 1)).status).toBe(409);
  });

  it('records a payment exactly once per request id', async () => {
    const bill = (await post('/api/bills', { supplierId: globex, amountCents: 1000, dueDate: daysFromNow(5) })).body;
    const first = await pay(bill.id, 300, 'same-request');
    const replay = await pay(bill.id, 300, 'same-request');
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.paidCents).toBe(300); // not 600
    expect(replay.body.payments).toHaveLength(1);
    expect((await pay(bill.id, 500, 'same-request')).status).toBe(409); // same id, different amount
    const other = (await post('/api/bills', { supplierId: globex, amountCents: 1000 })).body;
    expect((await pay(other.id, 300, 'same-request')).status).toBe(409); // same id on another bill
  });

  it('is safe under concurrent payments: the bill can never be overpaid', async () => {
    const bill = (await post('/api/bills', { supplierId: globex, amountCents: 1000, dueDate: daysFromNow(5) })).body;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => pay(bill.id, 300, `race-${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const final = (await get(`/api/bills/${bill.id}`)).body;
    expect(final.paidCents).toBe(900);
    expect(final.status).toBe('PARTIAL');
  });

  it('can void an unpaid bill, which frees its value to be billed again', async () => {
    const p = await po(acme, { tee: 10 });
    const bill = (await post('/api/bills', { purchaseOrderId: p.id })).body;
    expect((await post(`/api/bills/${bill.id}/void`, {})).body.status).toBe('VOID');
    expect((await post(`/api/bills/${bill.id}/void`, {})).status).toBe(409);
    expect((await pay(bill.id, 1)).status).toBe(409);
    expect((await post('/api/bills', { purchaseOrderId: p.id })).status).toBe(201);
    const paid = (await post('/api/bills', { supplierId: globex, amountCents: 100 })).body;
    await pay(paid.id, 50);
    expect((await post(`/api/bills/${paid.id}/void`, {})).status).toBe(409); // has payments
  });

  it('lists and reads bills; unknown ids are 404', async () => {
    const all = await get('/api/bills', viewer);
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThan(5);
    expect(all.body[0].number).toBeGreaterThan(all.body[1].number);
    expect((await get('/api/bills?status=PAID', viewer)).body.every((b: { status: string }) => b.status === 'PAID')).toBe(true);
    expect((await get(`/api/bills?supplierId=${acme}`, viewer)).body.every((b: { supplierId: string }) => b.supplierId === acme)).toBe(true);
    expect((await get('/api/bills?status=NOPE', viewer)).status).toBe(400);
    expect((await get('/api/bills/00000000-0000-4000-8000-000000000000', viewer)).status).toBe(404);
    expect((await get('/api/bills/not-a-uuid', viewer)).status).toBe(404);
  });

  it('is staff-only for writes', async () => {
    const bill = (await post('/api/bills', { supplierId: globex, amountCents: 100 })).body;
    expect((await post('/api/bills', { supplierId: globex, amountCents: 100 }, viewer)).status).toBe(403);
    expect((await pay(bill.id, 10, 'v1', viewer)).status).toBe(403);
    expect((await post(`/api/bills/${bill.id}/void`, {}, viewer)).status).toBe(403);
    expect((await request(t.app).get('/api/bills')).status).toBe(401);
    expect((await request(t.app).post('/api/bills').send({ supplierId: globex, amountCents: 1 })).status).toBe(401);
  });
});

describe('accounts payable summary (T61)', () => {
  it('shows the open and overdue balance per supplier, ignoring paid and void bills', async () => {
    const h = auth(staff);
    const sup = async (name: string) => (await request(t.app).post('/api/suppliers').set(h).send({ name })).body.id as string;
    const [a, b, c] = [await sup('A Co'), await sup('B Co'), await sup('C Co')];
    const bill = async (supplierId: string, amountCents: number, dueDate: string) =>
      (await request(t.app).post('/api/bills').set(h).send({ supplierId, amountCents, dueDate })).body as { id: string };
    await bill(a, 1000, daysFromNow(10));
    const overdue = await bill(a, 2000, daysFromNow(-3));
    await request(t.app).post(`/api/bills/${overdue.id}/payments`).set(h).send({ requestId: 'ap1', amountCents: 500, method: 'cash' });
    const settled = await bill(b, 700, daysFromNow(1));
    await request(t.app).post(`/api/bills/${settled.id}/payments`).set(h).send({ requestId: 'ap2', amountCents: 700, method: 'cash' });
    const voided = await bill(c, 900, daysFromNow(1));
    await request(t.app).post(`/api/bills/${voided.id}/void`).set(h).send({});

    const res = await request(t.app).get('/api/reports/payables').set(h);
    expect(res.status).toBe(200);
    const mine = res.body.suppliers.filter((r: { supplierId: string }) => [a, b, c].includes(r.supplierId));
    expect(mine).toEqual([{ supplierId: a, supplierName: 'A Co', openCents: 2500, overdueCents: 1500, billCount: 2 }]);
    const rows = res.body.suppliers as { openCents: number; overdueCents: number }[];
    expect(res.body.totalOpenCents).toBe(rows.reduce((n, r) => n + r.openCents, 0));
    expect(res.body.totalOverdueCents).toBe(rows.reduce((n, r) => n + r.overdueCents, 0));
    expect((await request(t.app).get('/api/reports/payables')).status).toBe(401);
    expect((await request(t.app).get('/api/reports/payables').set(auth(viewer))).status).toBe(403);
  });
});
