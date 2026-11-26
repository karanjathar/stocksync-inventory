import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { addTenant } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';
import { signInvoiceUrl } from '../src/services/signedUrl.js';

/** Every business has its own storefront; order and invoice links are tokens that find their business by themselves (T93). */
let t: TestApp; let A: string; let B: string; let ops: string;
const GST = { legalName: 'Alpha Traders Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: 'Pune', stateCode: '27', invoicePrefix: 'ALP', pricesIncludeTax: true };
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });

async function shop(tenant: string, opts: { name: string; price: number; whatsapp: string; gst?: boolean }) {
  return inTenant(tenant, async () => {
    const wh = (await t.pool.query<{ id: string }>("INSERT INTO warehouses (code, name) VALUES ('MAIN', 'Main') RETURNING id")).rows[0]!.id;
    const product = await t.c.repos.products.create({ sku: 'SHARED', name: opts.name, priceCents: opts.price, hsnCode: '610910', gstRateBp: 1200 });
    await t.c.stock.receive({ productId: product.id, warehouseId: wh, quantity: 50 }, null);
    await t.c.settings.update({ businessName: `${opts.name} Store`, currency: 'INR', whatsappNumber: opts.whatsapp, defaultWarehouseId: wh, ...(opts.gst ? { gst: GST } : {}) });
    return { wh, product };
  });
}
let sa: Awaited<ReturnType<typeof shop>>; let sb: Awaited<ReturnType<typeof shop>>;

beforeAll(async () => {
  t = await buildTestApp({ PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!' });
  A = await addTenant('shop-a', 'Shop A'); B = await addTenant('shop-b', 'Shop B');
  sa = await shop(A, { name: 'Alpha Tee', price: 11800, whatsapp: '919000000001', gst: true });
  sb = await shop(B, { name: 'Beta Mug', price: 5000, whatsapp: '919000000002' });
  ops = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token as string;
});
afterAll(async () => { await t.close(); });

const place = (slug: string, productId: string, extra: object = {}) => request(t.app).post(`/api/public/s/${slug}/orders`)
  .send({ name: 'Mia', phone: '919811112233', paymentMethod: 'COD', items: [{ productId, quantity: 2 }], ...extra });

describe('each business has its own storefront', () => {
  it('serves only that business\'s products and settings', async () => {
    const a = (await request(t.app).get('/api/public/s/shop-a/catalog')).body;
    const b = (await request(t.app).get('/api/public/s/shop-b/catalog')).body;
    expect(a.settings).toMatchObject({ businessName: 'Alpha Tee Store', whatsappNumber: '919000000001' });
    expect(b.settings).toMatchObject({ businessName: 'Beta Mug Store', whatsappNumber: '919000000002' });
    expect(a.products.map((p: { name: string }) => p.name)).toEqual(['Alpha Tee']);
    expect(b.products.map((p: { name: string }) => p.name)).toEqual(['Beta Mug']);
    expect(a.products[0].priceCents).toBe(11800);
    expect(JSON.stringify(b)).not.toContain('Alpha');
  });

  it('the original single-shop catalog URL still serves the default business', async () => {
    const legacy = (await request(t.app).get('/api/public/catalog')).body;
    expect(legacy.products).toEqual([]);
    expect(JSON.stringify(legacy)).not.toMatch(/Alpha|Beta/);
  });

  it('unknown, malformed and suspended shops are plain 404s', async () => {
    for (const slug of ['nope', 'Shop-A', 'a', '..%2Fshop-a', 'shop-a%00', 'x'.repeat(80), 'order']) {
      expect((await request(t.app).get(`/api/public/s/${slug}/catalog`)).status, slug).toBe(404);
    }
    const bId = ((await request(t.app).get('/api/platform/tenants').set(h(ops))).body as { id: string; slug: string }[]).find((x) => x.slug === 'shop-b')!.id;
    await request(t.app).patch(`/api/platform/tenants/${bId}`).set(h(ops)).send({ status: 'SUSPENDED' });
    expect((await request(t.app).get('/api/public/s/shop-b/catalog')).status).toBe(404);
    expect((await place('shop-b', sb.product.id)).status).toBe(404);
    await request(t.app).patch(`/api/platform/tenants/${bId}`).set(h(ops)).send({ status: 'ACTIVE' });
    expect((await request(t.app).get('/api/public/s/shop-b/catalog')).status).toBe(200);
  });
});

describe('ordering through a business\'s shop', () => {
  it('the order lands in that business only, and the order link finds it without a slug', async () => {
    const res = await place('shop-a', sa.product.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: 1, totalCents: 23600 });
    expect((await inTenant(A, () => t.pool.query('SELECT 1 FROM orders'))).rowCount).toBe(1);
    expect((await inTenant(B, () => t.pool.query('SELECT 1 FROM orders'))).rowCount).toBe(0);
    const status = (await request(t.app).get(`/api/public/orders/${res.body.token}`)).body;
    expect(status).toMatchObject({ number: 1, shop: 'shop-a', items: [{ name: 'Alpha Tee', quantity: 2 }] });
  });

  it('a business\'s shop refuses products of another business', async () => {
    expect((await place('shop-a', sb.product.id)).status).toBe(404);
    expect((await place('shop-b', sa.product.id)).status).toBe(404);
  });

  it('numbers and customers are per business: the same shopper is a separate customer in each', async () => {
    const b = await place('shop-b', sb.product.id);
    expect(b.body.number).toBe(1);
    expect((await inTenant(A, () => t.pool.query("SELECT 1 FROM customers WHERE channel_user_id = '919811112233'"))).rowCount).toBe(1);
    expect((await inTenant(B, () => t.pool.query("SELECT 1 FROM customers WHERE channel_user_id = '919811112233'"))).rowCount).toBe(1);
  });

  it('order links of a suspended business stop working and unknown tokens are 404', async () => {
    const order = await place('shop-b', sb.product.id);
    const bId = ((await request(t.app).get('/api/platform/tenants').set(h(ops))).body as { id: string; slug: string }[]).find((x) => x.slug === 'shop-b')!.id;
    await request(t.app).patch(`/api/platform/tenants/${bId}`).set(h(ops)).send({ status: 'SUSPENDED' });
    expect((await request(t.app).get(`/api/public/orders/${order.body.token}`)).status).toBe(404);
    await request(t.app).patch(`/api/platform/tenants/${bId}`).set(h(ops)).send({ status: 'ACTIVE' });
    expect((await request(t.app).get(`/api/public/orders/${order.body.token}`)).status).toBe(200);
    expect((await request(t.app).get('/api/public/orders/00000000-0000-4000-8000-0000000000aa')).status).toBe(404);
    expect((await request(t.app).get('/api/public/orders/not-a-token')).status).toBe(404);
  });
});

describe('invoices follow their own business', () => {
  it('the shopper\'s invoice link and a signed chat link both find the right business', async () => {
    const placed = await place('shop-a', sa.product.id, { phone: '919822223333' });
    const order = await inTenant(A, async () => (await t.c.orders.getByPublicToken(placed.body.token))!);
    await inTenant(A, () => t.c.orders.confirm(order.id, sa.wh, null));
    const byToken = await request(t.app).get(`/api/public/orders/${placed.body.token}/invoice.pdf`);
    expect(byToken.status).toBe(200);
    expect(byToken.headers['content-type']).toBe('application/pdf');
    const invoiceId = (await inTenant(A, () => t.pool.query<{ id: string }>('SELECT id FROM invoices WHERE order_id = $1', [order.id]))).rows[0]!.id;
    const signed = signInvoiceUrl(TEST_ENV.JWT_SECRET, 'https://x', invoiceId, 60_000).replace('https://x', '');
    expect((await request(t.app).get(signed)).status).toBe(200);
    const other = signInvoiceUrl(TEST_ENV.JWT_SECRET, 'https://x', '00000000-0000-4000-8000-0000000000bb', 60_000).replace('https://x', '');
    expect((await request(t.app).get(other)).status).toBe(404);
  });
});

describe('per-business web app manifest', () => {
  it('names the business and starts at its own shop', async () => {
    const res = await request(t.app).get('/api/public/s/shop-a/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/manifest+json');
    expect(res.body).toMatchObject({ name: 'Alpha Tee Store', start_url: '/shop/shop-a', display: 'standalone' });
    expect(res.body.scope).toBe('/shop/shop-a');
    expect((await request(t.app).get('/api/public/s/nope/manifest.webmanifest')).status).toBe(404);
  });
});
