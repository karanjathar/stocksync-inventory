import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';

let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
let admin: string;
let staff: string;
let viewer: string;
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
  await t.c.stock.receive({ productId: ids.mug.id, warehouseId: ids.shop.id, quantity: 500 }, null);
  await t.c.settings.update({ businessName: 'Corner Shop', currency: 'INR', defaultWarehouseId: ids.main.id, taxId: '29ABCDE1234F1Z5', businessAddress: '12 MG Road, Bengaluru' });
});
afterAll(async () => { await t.close(); });

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const get = (url: string, tok = staff) => request(t.app).get(url).set(auth(tok));
async function order(name = 'Asha', items = [{ productId: ids.tee.id, quantity: 2 }, { productId: ids.mug.id, quantity: 1 }], notes = '') {
  const c = await t.c.customers.findOrCreateByChannel('web', `91970000${String(++n).padStart(4, '0')}`, name);
  return t.c.orders.create({ customerId: c.id, channel: 'web', items, notes });
}
const invoiceFor = async (orderId: string) => (await get(`/api/invoices?orderId=${orderId}`)).body[0] as { id: string };

describe('printable invoice (T66)', () => {
  it('renders a self-contained A4 HTML invoice with seller, buyer, lines and totals', async () => {
    const o = await order();
    await t.c.orders.confirm(o.id, undefined, null);
    const inv = await invoiceFor(o.id);
    const res = await get(`/api/invoices/${inv.id}/print`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html; charset=utf-8/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const html = res.text;
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('@page { size: A4');
    for (const s of ['Corner Shop', '29ABCDE1234F1Z5', '12 MG Road, Bengaluru', 'Asha', 'TEE', 'MUG', 'T-Shirt', '18%']) expect(html).toContain(s);
    expect(html).toMatch(/INV-\d{4}-\d{6}/);
    expect(html).toContain('₹43.40'); // total
    expect(html).toContain('₹5.40');  // tax
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//); // nothing is fetched when printing
  });

  it('marks a void invoice clearly', async () => {
    const o = await order();
    await t.c.orders.confirm(o.id, undefined, null);
    const inv = await invoiceFor(o.id);
    await t.c.orders.cancel(o.id, null);
    expect((await get(`/api/invoices/${inv.id}/print`)).text).toMatch(/VOID/);
  });

  it('shows that prices include tax when they do', async () => {
    await t.c.settings.update({ pricesIncludeTax: true });
    const o = await order();
    await t.c.orders.confirm(o.id, undefined, null);
    const inv = await invoiceFor(o.id);
    expect((await get(`/api/invoices/${inv.id}/print`)).text).toMatch(/prices include tax/i);
    await t.c.settings.update({ pricesIncludeTax: false });
  });

  it('is staff-only; unknown ids are 404', async () => {
    const o = await order();
    await t.c.orders.confirm(o.id, undefined, null);
    const inv = await invoiceFor(o.id);
    expect((await get(`/api/invoices/${inv.id}/print`, viewer)).status).toBe(403);
    expect((await request(t.app).get(`/api/invoices/${inv.id}/print`)).status).toBe(401);
    expect((await get('/api/invoices/00000000-0000-4000-8000-000000000000/print')).status).toBe(404);
    expect((await get('/api/invoices/nope/print')).status).toBe(404);
  });
});

describe('escaping (T66)', () => {
  const evil = { name: '<script>alert(1)</script>', product: '<img src=x onerror=alert(1)>', notes: '"><svg onload=alert(1)>', address: "'><b onmouseover=alert(1)>x</b>" };

  it('never injects user text into any document unescaped', async () => {
    await t.c.settings.update({ businessAddress: evil.address, businessName: 'Evil & Sons <Ltd>' });
    await request(t.app).patch(`/api/products/${ids.mug.id}`).set(auth(staff)).send({ name: evil.product });
    const o = await order(evil.name, [{ productId: ids.mug.id, quantity: 1 }], evil.notes);
    await t.c.orders.confirm(o.id, undefined, null);
    const inv = await invoiceFor(o.id);
    const pages = [(await get(`/api/invoices/${inv.id}/print`)).text, (await get(`/api/orders/${o.id}/packing-slip`)).text, (await get(`/api/picklists?orderIds=${o.id}`)).text];
    for (const html of pages) {
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<svg onload');
      expect(html).not.toContain('<b onmouseover');
      expect(html).not.toMatch(/<[a-z]+[^>]*\sonerror=/i);
    }
    expect(pages[0]).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(pages[0]).toContain('Evil &amp; Sons &lt;Ltd&gt;');
    expect(pages[1]).toContain('&lt;img src=x onerror=alert(1)&gt;');
    await request(t.app).patch(`/api/products/${ids.mug.id}`).set(auth(staff)).send({ name: 'Mug' });
    await t.c.settings.update({ businessAddress: '12 MG Road, Bengaluru', businessName: 'Corner Shop' });
  });
});

describe('packing slip (T66)', () => {
  it('lists what to pack without prices', async () => {
    const o = await order('Ravi', undefined, 'Gift wrap please');
    const res = await get(`/api/orders/${o.id}/packing-slip`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    for (const s of ['Packing slip', `#${o.number}`, 'Ravi', 'TEE', 'T-Shirt', 'MUG', 'Gift wrap please']) expect(res.text).toContain(s);
    expect(res.text).not.toMatch(/₹|\$\d|15\.00|18%/); // no money on a packing slip
  });

  it('refuses cancelled orders, unknown ids and non-staff', async () => {
    const o = await order();
    await t.c.orders.cancel(o.id, null);
    expect((await get(`/api/orders/${o.id}/packing-slip`)).status).toBe(409);
    expect((await get('/api/orders/00000000-0000-4000-8000-000000000000/packing-slip')).status).toBe(404);
    const live = await order();
    expect((await get(`/api/orders/${live.id}/packing-slip`, viewer)).status).toBe(403);
  });
});

describe('bins and picklist (T66)', () => {
  it('sets a bin location on a stock row without changing quantity', async () => {
    const before = (await t.pool.query('SELECT quantity FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [ids.tee.id, ids.main.id])).rows[0].quantity;
    const res = await request(t.app).put('/api/stock/bin').set(auth(staff)).send({ productId: ids.tee.id, warehouseId: ids.main.id, bin: 'A-01' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ productId: ids.tee.id, warehouseId: ids.main.id, bin: 'A-01', quantity: before });
    expect((await request(t.app).put('/api/stock/bin').set(auth(viewer)).send({ productId: ids.tee.id, warehouseId: ids.main.id, bin: 'X' })).status).toBe(403);
    expect((await request(t.app).put('/api/stock/bin').set(auth(staff)).send({ productId: ids.tee.id, warehouseId: ids.main.id, bin: 'x'.repeat(41) })).status).toBe(400);
    expect((await request(t.app).put('/api/stock/bin').set(auth(staff)).send({ productId: ids.tee.id, warehouseId: '00000000-0000-4000-8000-000000000000', bin: 'B' })).status).toBe(404);
    const cleared = await request(t.app).put('/api/stock/bin').set(auth(staff)).send({ productId: ids.tee.id, warehouseId: ids.main.id, bin: null });
    expect(cleared.body.bin).toBeNull();
    await request(t.app).put('/api/stock/bin').set(auth(staff)).send({ productId: ids.tee.id, warehouseId: ids.main.id, bin: 'A-01' });
  });

  it('groups several orders by warehouse and bin, totals each product and lists who needs what', async () => {
    await request(t.app).put('/api/stock/bin').set(auth(staff)).send({ productId: ids.mug.id, warehouseId: ids.main.id, bin: 'B-07' });
    const a = await order('Asha', [{ productId: ids.tee.id, quantity: 2 }, { productId: ids.mug.id, quantity: 1 }]);
    const b = await order('Bhavna', [{ productId: ids.tee.id, quantity: 3 }]);
    const c = await order('Chetan', [{ productId: ids.mug.id, quantity: 4 }]);
    await t.c.orders.confirm(c.id, ids.shop.id, null); // confirmed from the other warehouse
    const res = await get(`/api/picklists?orderIds=${a.id},${b.id},${c.id}`);
    expect(res.status).toBe(200);
    const html = res.text;
    const main = html.indexOf('MAIN'); const shop = html.indexOf('SHOP');
    expect(main).toBeGreaterThan(-1);
    expect(shop).toBeGreaterThan(main); // warehouses in code order
    const mainPart = html.slice(main, shop);
    expect(mainPart.indexOf('A-01')).toBeGreaterThan(-1);
    expect(mainPart.indexOf('B-07')).toBeGreaterThan(mainPart.indexOf('A-01')); // bins in order
    expect(html).toMatch(/TEE[\s\S]*?>5</); // 2 + 3 tees picked together
    for (const who of [`#${a.number}`, `#${b.number}`, `#${c.number}`, 'Asha', 'Bhavna', 'Chetan']) expect(html).toContain(who);
    expect(html).toMatch(/Unassigned bin/); // the mug in the shop warehouse has no bin
  });

  it('only picks open orders and validates the list', async () => {
    const live = await order();
    const dead = await order();
    await t.c.orders.cancel(dead.id, null);
    expect((await get(`/api/picklists?orderIds=${live.id},${dead.id}`)).status).toBe(409);
    expect((await get(`/api/picklists?orderIds=${live.id},00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await get('/api/picklists')).status).toBe(400);
    expect((await get('/api/picklists?orderIds=not-a-uuid')).status).toBe(400);
    expect((await get(`/api/picklists?orderIds=${Array(51).fill(live.id).join(',')}`)).status).toBe(400);
    expect((await get(`/api/picklists?orderIds=${live.id}`, viewer)).status).toBe(403);
  });
});

describe('routing safety (T66)', () => {
  it('the document routes do not restrict unrelated endpoints for viewers', async () => {
    expect((await get('/api/products', viewer)).status).toBe(200);
    expect((await get('/api/orders', viewer)).status).toBe(200);
    expect((await get('/api/settings', viewer)).status).toBe(200);
    expect((await get('/api/dashboard', viewer)).status).toBe(200);
  });
});
