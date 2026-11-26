import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { TEST_DATABASE_URL } from './helpers/db.js';

/**
 * Performance budget on a realistic catalogue: 10,000 products, stock in two warehouses, and 20,000 past order lines. Each operation is timed 40 times through the
 * whole HTTP stack against a real PostgreSQL; the 95th percentile must stay under the budget. Budgets are 4–6× what the reference run measured (see the table in the deployment guide), so they catch a
 * lost index or an accidental N+1 (which cost 10–100×) without failing on a slower CI runner. Results are written to PERF_REPORT when set (docs/DEPLOYMENT_GUIDE.md).
 */
const PRODUCTS = 10_000; const RUNS = 40;
let t: TestApp; let owner: pg.Pool; let admin: string; let wh: string; let customer: string; let sampleIds: string[] = [];
const h = () => ({ authorization: `Bearer ${admin}` });
const report: Record<string, { p50: number; p95: number; max: number; budget: number }> = {};

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!; };
async function measure(name: string, budget: number, run: (i: number) => Promise<request.Response>, expectStatus = 200) {
  await run(-1); await run(-2); // warm the connection and the plan cache
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = process.hrtime.bigint();
    const res = await run(i);
    ms.push(Number(process.hrtime.bigint() - start) / 1e6);
    expect(res.status, `${name} #${i}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(expectStatus);
  }
  report[name] = { p50: Math.round(pct(ms, 50) * 10) / 10, p95: Math.round(pct(ms, 95) * 10) / 10, max: Math.round(Math.max(...ms) * 10) / 10, budget };
  expect(pct(ms, 95), `${name}: p95 ${report[name]!.p95} ms against a budget of ${budget} ms`).toBeLessThan(budget);
}

beforeAll(async () => {
  t = await buildTestApp();
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: '-c app.tenant_id=00000000-0000-4000-8000-000000000001' });
  admin = await t.token('admin');
  wh = (await request(t.app).post('/api/warehouses').set(h()).send({ code: 'MAIN', name: 'Main' })).body.id;
  const wh2 = (await request(t.app).post('/api/warehouses').set(h()).send({ code: 'SHOP', name: 'Shop' })).body.id;
  customer = (await request(t.app).post('/api/customers').set(h()).send({ name: 'Perf Buyer' })).body.id;
  await owner.query(`INSERT INTO products (sku, name, description, price_cents, reorder_level, barcode)
    SELECT 'SKU' || lpad(g::text, 6, '0'), 'Widget ' || g || CASE g % 7 WHEN 0 THEN ' Blue' WHEN 1 THEN ' Red' ELSE ' Green' END, 'Standard widget number ' || g, 100 + (g % 900), CASE WHEN g % 10 = 0 THEN 5 ELSE 0 END,
           'BC' || lpad(g::text, 8, '0') FROM generate_series(1, $1) g`, [PRODUCTS]);
  await owner.query('INSERT INTO stock_levels (product_id, warehouse_id, quantity) SELECT id, $1, 50 FROM products', [wh]);
  await owner.query('INSERT INTO stock_levels (product_id, warehouse_id, quantity) SELECT id, $1, 10 FROM products WHERE (length(sku) + ascii(right(sku, 1))) % 3 = 0', [wh2]);
  // history: 5,000 orders of 4 lines over the last 90 days (what dashboards and analytics read)
  await owner.query(`INSERT INTO orders (customer_id, channel, status, total_cents, created_at)
    SELECT $1, (ARRAY['whatsapp','web','telegram'])[1 + g % 3], CASE WHEN g % 20 = 0 THEN 'CANCELLED' ELSE 'FULFILLED' END, 4000, now() - make_interval(days => g % 90) FROM generate_series(1, 5000) g`, [customer]);
  await owner.query(`INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
    SELECT o.id, p.id, 1 + (n % 3), 1000 FROM (SELECT id, row_number() OVER () AS rn FROM orders) o
    CROSS JOIN generate_series(1, 4) n JOIN LATERAL (SELECT id FROM products ORDER BY sku OFFSET ((o.rn * 7 + n * 131) % ${PRODUCTS}) LIMIT 1) p ON true`);
  await owner.query('ANALYZE');
  sampleIds = (await owner.query<{ id: string }>('SELECT id FROM products ORDER BY sku LIMIT 200')).rows.map((r) => r.id);
}, 120_000);

afterAll(async () => {
  if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, JSON.stringify({ products: PRODUCTS, runs: RUNS, report }, null, 1));
  await owner.end(); await t.close();
});

describe('10,000-product catalogue: 95th percentile budgets', () => {
  it('product list (first page)', async () => { await measure('list products', 250, () => request(t.app).get('/api/products').set(h())); }, 60_000);
  it('product search by name', async () => { await measure('search products', 200, (i) => request(t.app).get(`/api/products?search=${encodeURIComponent(`Widget ${1000 + (i % 50)}`)}`).set(h())); }, 60_000);
  it('search by SKU', async () => { await measure('search by sku', 200, (i) => request(t.app).get(`/api/products?search=SKU00${1000 + (i % 50)}`).set(h())); }, 60_000);
  it('barcode scan lookup', async () => { await measure('barcode lookup', 60, (i) => request(t.app).get(`/api/products/by-barcode/BC${String(100 + (i % 50)).padStart(8, '0')}`).set(h())); }, 60_000);
  it('dashboard figures', async () => { await measure('dashboard', 150, () => request(t.app).get('/api/dashboard').set(h())); }, 60_000);
  it('low-stock list', async () => { await measure('low stock list', 100, () => request(t.app).get('/api/products?lowStock=true').set(h())); }, 60_000);
  it('stock levels', async () => { await measure('stock levels', 400, () => request(t.app).get('/api/stock').set(h())); }, 60_000);
  it('creating an order of 3 lines', async () => {
    await measure('create order', 80, (i) => request(t.app).post('/api/orders').set(h()).send({ customerId: customer, channel: 'manual', items: [0, 1, 2].map((n) => ({ productId: sampleIds[(i * 3 + n + 5) % 200]!, quantity: 1 })) }), 201);
  }, 60_000);
  it('analytics: 30-day sales, best sellers and funnel', async () => {
    await measure('analytics sales', 150, () => request(t.app).get('/api/analytics/sales').set(h()));
    await measure('analytics best sellers', 200, () => request(t.app).get('/api/analytics/best-sellers').set(h()));
    await measure('analytics funnel', 60, () => request(t.app).get('/api/analytics/funnel').set(h()));
  }, 120_000);
  it('reorder suggestions (forecast over the catalogue)', async () => { await measure('reorder suggestions', 400, () => request(t.app).get('/api/reorder-suggestions').set(h())); }, 60_000);
});
