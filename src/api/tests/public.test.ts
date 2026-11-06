import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { ImageStorage } from '../src/storage/blob.js';

// Azurite's publicly documented development account key (not a secret).
const AZURITE = 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

let t: TestApp;
let staff: string;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
beforeAll(async () => {
  t = await buildTestApp({ AZURE_STORAGE_CONNECTION_STRING: AZURITE });
  staff = await t.token('staff');
  ids = await seedCatalog(t, staff);
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 4 }, null);
  await t.c.settings.update({ businessName: 'Corner Shop', whatsappNumber: '15550001234' });
});
afterAll(async () => { await t.close(); });
const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

describe('image upload SAS', () => {
  it('allows the configured Blob endpoint in the CSP so browsers can upload and show images', async () => {
    const csp = (await request(t.app).get('/healthz')).headers['content-security-policy'] as string;
    expect(csp).toMatch(/connect-src[^;]*http:\/\/127\.0\.0\.1:10000/);
    expect(csp).toMatch(/img-src[^;]*http:\/\/127\.0\.0\.1:10000/);
  });

  it('reports whether uploads are configured', async () => {
    const res = await request(t.app).get('/api/uploads/status').set(auth(staff));
    expect(res.body).toEqual({ configured: true });
  });

  it('issues a short-lived write-only SAS for images', async () => {
    const res = await request(t.app).post('/api/uploads/image-sas').set(auth(staff)).send({ filename: 'red tee.PNG', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.blobUrl).toMatch(/^http:\/\/127\.0\.0\.1:10000\/devstoreaccount1\/product-images\/\d{4}\/[0-9a-f-]{36}\.png$/);
    const sas = new URL(res.body.uploadUrl).searchParams;
    expect(sas.get('sp')).toBe('cw');
    expect(sas.get('sig')).toBeTruthy();
    expect(new Date(sas.get('se')!).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(res.body.blobUrl).not.toContain('sig=');
  });

  it('rejects non-image types and viewers; 501 when storage is not configured', async () => {
    expect((await request(t.app).post('/api/uploads/image-sas').set(auth(staff)).send({ filename: 'x.svg', contentType: 'image/svg+xml' })).status).toBe(400);
    expect((await request(t.app).post('/api/uploads/image-sas').set(auth(await t.token('viewer'))).send({ filename: 'x.png', contentType: 'image/png' })).status).toBe(403);
    const unconfigured = new ImageStorage(undefined, 'product-images');
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(unconfigured.createUploadSas('image/png')).rejects.toMatchObject({ status: 501, code: 'NOT_CONFIGURED' });
  });
});

describe('public catalog', () => {
  it('is anonymous and exposes only safe fields of active products', async () => {
    const res = await request(t.app).get('/api/public/catalog');
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ businessName: 'Corner Shop', currency: 'USD', whatsappNumber: '15550001234', paymentMethods: ['COD'] }); // Razorpay not configured here
    const tee = res.body.products.find((p: { sku: string }) => p.sku === 'TEE');
    expect(tee).toEqual({ id: ids.tee.id, sku: 'TEE', name: 'T-Shirt', description: '', priceCents: 1500, unit: 'pcs', imageUrl: null, attributes: {}, categoryId: null, inStock: true, available: 4 });
    expect(res.body.products.find((p: { sku: string }) => p.sku === 'MUG').inStock).toBe(false);
    expect(res.body).not.toHaveProperty('alertRecipients');
  });
});

describe('public orders', () => {
  it('creates a PENDING web order and a web customer', async () => {
    const res = await request(t.app).post('/api/public/orders').send({ name: 'Mia', phone: '+1 555 000 7777', items: [{ productId: ids.tee.id, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ number: expect.any(Number), status: 'PENDING', totalCents: 3000, paymentMethod: 'COD', token: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const order = await t.c.orders.getByNumber(res.body.number);
    expect(order).toMatchObject({ channel: 'web', customerName: 'Mia' });
    const cust = await t.c.customers.get(order!.customerId);
    expect(cust).toMatchObject({ channel: 'web', phone: '+15550007777' });
  });

  it('rejects orders above available stock and bad input', async () => {
    expect((await request(t.app).post('/api/public/orders').send({ name: 'Mia', phone: '+15550007777', items: [{ productId: ids.tee.id, quantity: 5 }] })).status).toBe(409);
    expect((await request(t.app).post('/api/public/orders').send({ name: '', phone: 'abc', items: [] })).status).toBe(400);
  });
});
