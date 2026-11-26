import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { TEST_DATABASE_URL } from './helpers/db.js';
import { backtest, enoughHistory, forecastDaily, MIN_HISTORY_DAYS, naiveDaily, sum, trimLeadingZeros, weeklyFactors } from '../src/services/forecast.js';

/** Seeded generator (mulberry32): the same numbers on every run, so every figure below is reproducible. */
function rng(seed: number) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
/** Daily units: weekday pattern (Sun..Sat), growth per day, noise. */
function series(days: number, o: { base: number; weekly: number[]; growth: number; noise: number; seed: number }): number[] {
  const r = rng(o.seed);
  return Array.from({ length: days }, (_, i) => Math.max(0, Math.round(o.base * (1 + o.growth * i) * o.weekly[i % 7]! + gauss(r) * o.noise)));
}
const SHOP_WEEK = [1.8, 0.7, 0.6, 0.7, 0.8, 1.2, 1.9]; // a shop that sells most on weekends (average 1.1 → normalised by the model)

describe('forecast building blocks', () => {
  it('weekly factors recover the pattern and average 1', () => {
    const s = series(84, { base: 20, weekly: SHOP_WEEK, growth: 0, noise: 1, seed: 1 });
    const f = weeklyFactors(s, 0);
    expect(f.reduce((a, b) => a + b, 0) / 7).toBeCloseTo(1, 10);
    expect(f[6]!).toBeGreaterThan(f[2]! * 2);                       // Saturday far above Tuesday
    expect(weeklyFactors(new Array<number>(30).fill(0), 0)).toEqual(new Array<number>(7).fill(1));
  });

  it('is deterministic and never negative; a flat series forecasts flat', () => {
    const s = new Array<number>(60).fill(5);
    const a = forecastDaily(s, 3, 14); const b = forecastDaily(s, 3, 14);
    expect(a).toEqual(b);
    a.forEach((v) => expect(v).toBeCloseTo(5, 6));
    expect(forecastDaily([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0, 10).every((v) => v >= 0)).toBe(true);
    expect(forecastDaily([], 0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(forecastDaily(new Array<number>(40).fill(0), 0, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it('follows a rising trend, but only part-way (damped) so one good month is not extrapolated forever', () => {
    const up = series(56, { base: 10, weekly: [1, 1, 1, 1, 1, 1, 1], growth: 0.03, noise: 0, seed: 2 });
    const f = forecastDaily(up, 0, 30);
    expect(f[0]!).toBeGreaterThan(up.at(-1)! * 0.9);
    expect(f[29]!).toBeGreaterThan(f[0]!);
    expect(f[29]!).toBeLessThan(up.at(-1)! * 2);                    // far below straight-line growth, which would be about 1.9× → 3.4×
  });

  it('trims the days before the first sale and judges whether there is enough history', () => {
    const t = trimLeadingZeros([0, 0, 0, 4, 5, 6], 1);
    expect(t).toEqual({ series: [4, 5, 6], startDow: 4 });
    expect(trimLeadingZeros([1, 2], 2)).toEqual({ series: [1, 2], startDow: 2 });
    expect(enoughHistory(new Array<number>(MIN_HISTORY_DAYS).fill(1))).toBe(true);
    expect(enoughHistory(new Array<number>(MIN_HISTORY_DAYS - 1).fill(1))).toBe(false);          // too short
    expect(enoughHistory([...new Array<number>(40).fill(0), 1, 1, 1])).toBe(false);              // long but almost no sales
    expect(naiveDaily([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2)).toEqual([7, 7]);                      // mean of the last seven days
    expect(sum([1, 2, 3])).toBe(6);
  });
});

describe('back-test against the naive baseline (seeded data)', () => {
  const horizons = [3, 4, 10];       // typical supplier lead times: whole weeks hide the weekly pattern, other lengths do not

  it('beats "the last seven days\' average" clearly on a shop with a weekly pattern and growth', () => {
    const s = series(180, { base: 20, weekly: SHOP_WEEK, growth: 0.004, noise: 2, seed: 42 });
    const report = horizons.map((h) => backtest(s, 0, h, 12)!);
    for (const r of report) {
      expect(r.folds).toBe(12);
      expect(r.modelError).toBeLessThan(r.naiveError);
      expect(r.improvement).toBeGreaterThan(0.25);                                               // at least a quarter less error
    }
    // The figures in the report are exactly reproducible.
    expect(report.map((r) => Math.round(r.improvement * 100))).toEqual(horizons.map((h) => Math.round(backtest(s, 0, h, 12)!.improvement * 100)));
  });

  it('is not meaningfully worse than the baseline when demand is flat noise', () => {
    const s = series(180, { base: 12, weekly: [1, 1, 1, 1, 1, 1, 1], growth: 0, noise: 3, seed: 7 });
    for (const h of horizons) {
      const r = backtest(s, 0, h, 12)!;
      expect(r.modelError).toBeLessThanOrEqual(r.naiveError * 1.15);
    }
  });

  it('reports nothing when there is too little history or no sales to judge against', () => {
    expect(backtest(new Array<number>(20).fill(3), 0, 7)).toBeUndefined();
    expect(backtest(new Array<number>(100).fill(0), 0, 7)).toBeUndefined();
  });
});

describe('reorder suggestions use the forecast when there is history', () => {
  let t: TestApp; let owner: pg.Pool; let staff: string; let ids: Awaited<ReturnType<typeof seedCatalog>>; let supplier: string; let customer: string;
  const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const make = async (sku: string, reorderLevel: number) => (await request(t.app).post('/api/products').set(h(staff)).send({ sku, name: sku, priceCents: 100, reorderLevel })).body.id as string;
  const list = async () => (await request(t.app).get('/api/reorder-suggestions').set(h(staff))).body.suggestions as { sku: string; suggestedQuantity: number; basis: string; forecastUnits: number | null; leadTimeDays: number }[];
  /** Writes one order per day of history (UTC, ending yesterday) straight into the database with its real date. */
  async function sell(productId: string, perDay: number[]) {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    for (let i = 0; i < perDay.length; i++) {
      const qty = perDay[i]!; if (!qty) continue;
      const day = new Date(today.getTime() - (perDay.length - i) * 86_400_000 + 12 * 3_600_000);
      const o = (await owner.query<{ id: string }>("INSERT INTO orders (customer_id, channel, status, total_cents, created_at) VALUES ($1, 'manual', 'FULFILLED', $2, $3) RETURNING id", [customer, qty * 100, day])).rows[0]!.id;
      await owner.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, 100)', [o, productId, qty]);
    }
  }
  const supply = async (productId: string, days: number) => {
    await request(t.app).patch(`/api/suppliers/${supplier}`).set(h(staff)).send({ leadTimeDays: days });
    const po = await t.c.purchaseOrders.create({ supplierId: supplier, warehouseId: ids.main.id, lines: [{ productId, quantity: 1, unitCostCents: 50 }] }, null);
    await t.c.purchaseOrders.send(po.id); await t.c.purchaseOrders.receive(po.id, `r-${po.id}`, [{ productId, quantity: 1 }], null);
  };

  beforeAll(async () => {
    t = await buildTestApp(); owner = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: '-c app.tenant_id=00000000-0000-4000-8000-000000000001' }); // the default business, so numbering triggers know whose order it is
    staff = await t.token('staff'); ids = await seedCatalog(t, staff);
    supplier = (await request(t.app).post('/api/suppliers').set(h(staff)).send({ name: 'Acme', leadTimeDays: 10 })).body.id;
    customer = (await request(t.app).post('/api/customers').set(h(staff)).send({ name: 'Hist' })).body.id;
    await t.c.settings.update({ defaultWarehouseId: ids.main.id });
  });
  afterAll(async () => { await owner.end(); await t.close(); });

  it('a supplier has a delivery time (default 7 days) that can be changed, within limits', async () => {
    const s = (await request(t.app).get(`/api/suppliers/${supplier}`).set(h(staff))).body;
    expect(s.leadTimeDays).toBe(10);
    const other = (await request(t.app).post('/api/suppliers').set(h(staff)).send({ name: 'Plain' })).body;
    expect(other.leadTimeDays).toBe(7);
    expect((await request(t.app).patch(`/api/suppliers/${supplier}`).set(h(staff)).send({ leadTimeDays: 400 })).status).toBe(400);
    expect((await request(t.app).patch(`/api/suppliers/${supplier}`).set(h(staff)).send({ leadTimeDays: 1.5 })).status).toBe(400);
  });

  it('sizes the order from expected demand over lead time + a week, keeping the reorder level as safety stock', async () => {
    const steady = await make('STEADY', 10);
    await sell(steady, new Array<number>(60).fill(6));                       // 6 a day for two months
    await supply(steady, 10);
    await t.c.stock.receive({ productId: steady, warehouseId: ids.main.id, quantity: 29 }, null); // 30 in stock, well above the reorder level of 10
    const s = (await list()).find((x) => x.sku === 'STEADY')!;
    // The old rule would not even list it (30 > 10). Demand 6/day × (10 days lead + 7 review) = 102, + 10 safety − 30 in stock = 82.
    expect(s).toMatchObject({ basis: 'forecast', suggestedQuantity: 82, leadTimeDays: 10 });
    expect(s.forecastUnits).toBeCloseTo(102, 0);
  });

  it('does not suggest a product that sells slowly even though it is below its level, and falls back to the rule when history is short', async () => {
    const slow = await make('SLOW', 10);
    await sell(slow, [...new Array<number>(55).fill(0), 1, 0, 0, 1, 0]);      // two sales in 60 days: not enough selling days → rules
    await supply(slow, 10);
    await t.c.stock.receive({ productId: slow, warehouseId: ids.main.id, quantity: 4 }, null);   // 5 in stock ≤ 10
    const s = (await list()).find((x) => x.sku === 'SLOW')!;
    expect(s).toMatchObject({ basis: 'rules', suggestedQuantity: 15, forecastUnits: null });        // 2 × 10 − 5, the original rule

    const dormant = await make('DORMANT', 10);
    await sell(dormant, [...new Array<number>(30).fill(1), ...new Array<number>(30).fill(0)]);       // sold daily a month ago, nothing since
    await supply(dormant, 10);
    await t.c.stock.receive({ productId: dormant, warehouseId: ids.main.id, quantity: 8 }, null);
    const d = (await list()).find((x) => x.sku === 'DORMANT');
    expect(d?.basis ?? 'forecast').toBe('forecast');                                                  // judged on the forecast, not the old rule
    expect(d === undefined || d.suggestedQuantity <= 12).toBe(true);
  });

  it('ignores cancelled orders and a product with no history keeps the original rule', async () => {
    const fresh = await make('FRESH', 10);
    await t.c.stock.receive({ productId: fresh, warehouseId: ids.main.id, quantity: 3 }, null);
    expect((await list()).find((x) => x.sku === 'FRESH')).toMatchObject({ basis: 'rules', suggestedQuantity: 17 });
    const ghost = await make('GHOST', 10);
    await sell(ghost, new Array<number>(60).fill(9));
    await owner.query("UPDATE orders SET status = 'CANCELLED' WHERE id IN (SELECT order_id FROM order_items WHERE product_id = $1)", [ghost]);
    await t.c.stock.receive({ productId: ghost, warehouseId: ids.main.id, quantity: 3 }, null);
    expect((await list()).find((x) => x.sku === 'GHOST')).toMatchObject({ basis: 'rules' });           // all its orders were cancelled: no demand history at all
  });

  it('purchase orders created from suggestions use the forecast quantity', async () => {
    const res = await request(t.app).post('/api/reorder-suggestions/create-pos').set(h(staff)).send({ productIds: [(await t.c.repos.products.getBySku('STEADY'))!.id] });
    expect(res.status).toBe(201);
    const line = res.body.created[0].lines[0];
    expect(line.quantity).toBe(82);
  });
});
