import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';

let t: TestApp; let admin: string; let staff: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
beforeAll(async () => { t = await buildTestApp(); admin = await t.token('admin'); staff = await t.token('staff'); });
afterAll(async () => { await t.close(); });

const GOOD_GSTIN = '27AAPFU0939F1ZV'; // Maharashtra (27); structurally valid test value

describe('GST settings', () => {
  it('has safe defaults (inclusive prices, prefix INV, nothing configured)', async () => {
    const res = await request(t.app).get('/api/settings').set(h(staff));
    expect(res.body.gst).toEqual({ legalName: '', gstin: '', address: '', stateCode: '', invoicePrefix: 'INV', pricesIncludeTax: true });
  });

  it('saves a valid GST profile', async () => {
    const gst = { legalName: 'Corner Shop Pvt Ltd', gstin: GOOD_GSTIN, address: '12 MG Road, Pune', stateCode: '27', invoicePrefix: 'CS', pricesIncludeTax: false };
    const res = await request(t.app).put('/api/settings').set(h(admin)).send({ gst });
    expect(res.status).toBe(200);
    expect(res.body.gst).toEqual(gst);
    expect((await t.c.settings.get()).gst).toEqual(gst);
  });

  it('rejects malformed GSTIN, state code and prefix, and a GSTIN that disagrees with the state', async () => {
    const base = { legalName: 'X', gstin: GOOD_GSTIN, address: 'A', stateCode: '27', invoicePrefix: 'INV', pricesIncludeTax: true };
    for (const bad of [
      { gstin: '27AAPFU0939F1Z' }, { gstin: 'not-a-gstin' }, { gstin: GOOD_GSTIN.toLowerCase() === GOOD_GSTIN ? 'x' : GOOD_GSTIN.slice(0, 14) + '!' },
      { stateCode: '99X' }, { stateCode: '40' }, { stateCode: '29' }, // 29 ≠ the 27 in the GSTIN
      { invoicePrefix: 'bad prefix' }, { invoicePrefix: 'TOOLONGPREFIX' }, { legalName: 'x'.repeat(201) },
    ]) {
      const res = await request(t.app).put('/api/settings').set(h(admin)).send({ gst: { ...base, ...bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('allows an empty profile (invoicing not set up yet) and is admin-only', async () => {
    expect((await request(t.app).put('/api/settings').set(h(admin)).send({ gst: { legalName: '', gstin: '', address: '', stateCode: '', invoicePrefix: 'INV', pricesIncludeTax: true } })).status).toBe(200);
    expect((await request(t.app).put('/api/settings').set(h(staff)).send({ gst: { legalName: 'x', gstin: '', address: '', stateCode: '', invoicePrefix: 'INV', pricesIncludeTax: true } })).status).toBe(403);
  });
});

describe('product HSN code and GST rate', () => {
  it('defaults to no HSN and 0%, and stores both when given', async () => {
    const plain = (await request(t.app).post('/api/products').set(h(staff)).send({ sku: 'G-PLAIN', name: 'Plain', priceCents: 100 })).body;
    expect(plain).toMatchObject({ hsnCode: null, gstRateBp: 0 });
    const tee = await request(t.app).post('/api/products').set(h(staff)).send({ sku: 'G-TEE', name: 'Tee', priceCents: 1000, hsnCode: '610910', gstRateBp: 1200 });
    expect(tee.status).toBe(201);
    expect(tee.body).toMatchObject({ hsnCode: '610910', gstRateBp: 1200 });
    const patched = await request(t.app).patch(`/api/products/${tee.body.id}`).set(h(staff)).send({ gstRateBp: 500, hsnCode: null });
    expect(patched.body).toMatchObject({ hsnCode: null, gstRateBp: 500 });
  });

  it('rejects bad HSN codes and rates', async () => {
    for (const bad of [{ hsnCode: '12' }, { hsnCode: 'ABCD' }, { hsnCode: '123456789' }, { gstRateBp: -1 }, { gstRateBp: 2801 }, { gstRateBp: 12.5 }]) {
      const res = await request(t.app).post('/api/products').set(h(staff)).send({ sku: `G-BAD-${Math.random().toString(36).slice(2, 8)}`, name: 'Bad', priceCents: 1, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('customer GSTIN and state', () => {
  it('stores a business customer GST profile and validates it', async () => {
    const ok = await request(t.app).post('/api/customers').set(h(staff)).send({ name: 'Acme Traders', gstin: '29AAPFU0939F1ZV', stateCode: '29' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ gstin: '29AAPFU0939F1ZV', stateCode: '29' });
    const plain = await request(t.app).post('/api/customers').set(h(staff)).send({ name: 'Walk-in' });
    expect(plain.body).toMatchObject({ gstin: null, stateCode: null });
    for (const bad of [{ gstin: 'nope' }, { stateCode: '123' }, { gstin: '29AAPFU0939F1ZV', stateCode: '27' }]) {
      expect((await request(t.app).post('/api/customers').set(h(staff)).send({ name: 'Bad', ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });
});
