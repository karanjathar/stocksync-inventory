import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { normaliseBarcode, validBarcode } from '../src/domain/barcode.js';

let t: TestApp; let staff: string; let viewer: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
beforeAll(async () => { t = await buildTestApp(); staff = await t.token('staff'); viewer = await t.token('viewer'); });
afterAll(async () => { await t.close(); });
let n = 0;
const make = (extra: object = {}) => request(t.app).post('/api/products').set(h(staff)).send({ sku: `BC-${++n}`, name: `Item ${n}`, priceCents: 100, ...extra });

describe('barcode rules', () => {
  it('normalises case and surrounding space', () => {
    expect(normaliseBarcode('  abc-12345 ')).toBe('ABC-12345');
  });
  it('checks the EAN-13 checksum for 13 digits and the shape of other codes', () => {
    expect(validBarcode('4006381333931')).toBe(true);      // real EAN-13
    expect(validBarcode('4006381333932')).toBe(false);     // wrong check digit
    expect(validBarcode('5901234123457')).toBe(true);
    expect(validBarcode('ABC-12345')).toBe(true);          // internal / Code-128 style
    expect(validBarcode('1234567')).toBe(false);           // too short
    expect(validBarcode('A'.repeat(49))).toBe(false);      // too long
    expect(validBarcode('BAD CODE!')).toBe(false);         // characters that scanners never produce
    expect(validBarcode('')).toBe(false);
  });
});

describe('product barcode API', () => {
  it('stores a normalised barcode, and many products may have none', async () => {
    const a = await make({ barcode: ' abc-12345 ' });
    expect(a.status).toBe(201);
    expect(a.body.barcode).toBe('ABC-12345');
    expect((await make()).body.barcode).toBeNull();
    expect((await make()).status).toBe(201);
    expect((await make({ barcode: '4006381333931' })).status).toBe(201);
  });

  it('rejects a malformed barcode or a bad EAN-13 checksum with 400', async () => {
    for (const barcode of ['4006381333932', '12', 'has space inside', 'x'.repeat(60)]) expect((await make({ barcode })).status, barcode).toBe(400);
  });

  it('refuses a duplicate barcode with 409, ignoring case', async () => {
    await make({ barcode: 'DUP-0001' });
    expect((await make({ barcode: 'dup-0001' })).status).toBe(409);
    const other = await make({ barcode: 'DUP-0002' });
    expect((await request(t.app).patch(`/api/products/${other.body.id}`).set(h(staff)).send({ barcode: 'DUP-0001' })).status).toBe(409);
  });

  it('can be cleared and reused afterwards', async () => {
    const p = await make({ barcode: 'REUSE-001' });
    const cleared = await request(t.app).patch(`/api/products/${p.body.id}`).set(h(staff)).send({ barcode: null });
    expect(cleared.body.barcode).toBeNull();
    expect((await make({ barcode: 'REUSE-001' })).status).toBe(201);
  });
});

describe('GET /api/products/by-barcode/:code', () => {
  it('resolves a scan (case-insensitive) for any signed-in user', async () => {
    const p = await make({ barcode: 'SCAN-0001', name: 'Scannable' });
    for (const code of ['SCAN-0001', 'scan-0001', encodeURIComponent(' scan-0001 ')]) {
      const res = await request(t.app).get(`/api/products/by-barcode/${code}`).set(h(viewer));
      expect(res.status, code).toBe(200);
      expect(res.body).toMatchObject({ id: p.body.id, name: 'Scannable', barcode: 'SCAN-0001' });
    }
  });

  it('is 404 for unknown or malformed codes and 401 without a login', async () => {
    expect((await request(t.app).get('/api/products/by-barcode/NOPE-0001').set(h(viewer))).status).toBe(404);
    expect((await request(t.app).get('/api/products/by-barcode/%00%00').set(h(viewer))).status).toBe(404);
    expect((await request(t.app).get(`/api/products/by-barcode/${'9'.repeat(200)}`).set(h(viewer))).status).toBe(404);
    expect((await request(t.app).get('/api/products/by-barcode/SCAN-0001')).status).toBe(401);
  });
});
