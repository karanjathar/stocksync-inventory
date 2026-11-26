import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';
import { resolveRange } from '../src/services/analytics.js';

const DEFAULT = '00000000-0000-4000-8000-000000000001';
let t: TestApp; let owner: pg.Pool; let admin: string; let staff: string; let viewer: string; let tokB: string;
let ids: Awaited<ReturnType<typeof seedCatalog>>; let customer: string; let tee: string; let mug: string; let lamp: string; let dusty: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const get = (tok: string, path: string) => request(t.app).get(`/api/analytics${path}`).set(h(tok));
const dayAgo = (n: number, hour = 12) => { const d = new Date(); d.setUTCHours(hour, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d; };
const dateStr = (n: number) => dayAgo(n).toISOString().slice(0, 10);

/** One order straight into the database with a chosen date, channel and status. */
async function order(opts: { daysAgo: number; channel: string; status?: string; payment?: string; items: [string, number, number][] }) {
  const total = opts.items.reduce((a, [, q, p]) => a + q * p, 0);
  const o = (await owner.query<{ id: string }>("INSERT INTO orders (customer_id, channel, status, payment_status, total_cents, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [customer, opts.channel, opts.status ?? 'FULFILLED', opts.payment ?? 'UNPAID', total, dayAgo(opts.daysAgo)])).rows[0]!.id;
  for (const [product, qty, price] of opts.items) await owner.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)', [o, product, qty, price]);
}

beforeAll(async () => {
  t = await buildTestApp();
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c app.tenant_id=${DEFAULT}` });
  admin = await t.token('admin'); staff = await t.token('staff'); viewer = await t.token('viewer');
  ids = await seedCatalog(t, admin);
  tee = ids.tee.id; mug = ids.mug.id;
  lamp = (await request(t.app).post('/api/products').set(h(admin)).send({ sku: 'LAMP', name: 'Lamp', priceCents: 5000 })).body.id;
  dusty = (await request(t.app).post('/api/products').set(h(admin)).send({ sku: 'DUSTY', name: 'Dusty box', priceCents: 1000 })).body.id;
  customer = (await request(t.app).post('/api/customers').set(h(admin)).send({ name: 'Buyer' })).body.id;
  for (const p of [tee, mug, lamp, dusty]) await t.c.stock.receive({ productId: p, warehouseId: ids.main.id, quantity: 20 }, null);
  // ---- sales history (prices are the order-line prices: tee 1500, mug 800, lamp 5000) ----
  await order({ daysAgo: 1, channel: 'whatsapp', payment: 'PAID', items: [[tee, 2, 1500], [mug, 1, 800]] });                 // 3800
  await order({ daysAgo: 1, channel: 'web', items: [[tee, 1, 1500]] });                                                      // 1500
  await order({ daysAgo: 3, channel: 'whatsapp', status: 'CONFIRMED', items: [[lamp, 1, 5000]] });                           // 5000
  await order({ daysAgo: 3, channel: 'telegram', status: 'PENDING', items: [[mug, 4, 800]] });                               // 3200
  await order({ daysAgo: 3, channel: 'whatsapp', status: 'CANCELLED', items: [[lamp, 9, 5000]] });                           // cancelled: counts nowhere
  await order({ daysAgo: 40, channel: 'web', items: [[tee, 5, 1500]] });                                                     // outside the default 30 days
  // ---- stock movements: tee/mug/lamp sold recently; dusty last left 100 days ago; ----
  for (const p of [tee, mug, lamp]) await owner.query("INSERT INTO stock_movements (product_id, warehouse_id, type, quantity_delta, balance_after, created_at) VALUES ($1, $2, 'OUT', -1, 19, $3)", [p, ids.main.id, dayAgo(2)]);
  await owner.query("INSERT INTO stock_movements (product_id, warehouse_id, type, quantity_delta, balance_after, created_at) VALUES ($1, $2, 'OUT', -1, 19, $3)", [dusty, ids.main.id, dayAgo(100)]);
  await owner.query("UPDATE products SET created_at = now() - interval '200 days'");
  // ---- chat: 3 people wrote in (two of them twice), one wrote long ago ----
  for (const [user, d] of [['a', 2], ['a', 1], ['b', 1], ['c', 2], ['old', 60]] as [string, number][]) {
    await owner.query("INSERT INTO channel_messages (channel, direction, external_user, text, status, created_at) VALUES ('whatsapp', 'in', $1, 'hi', 'ok', $2)", [user, dayAgo(d)]);
  }
  // ---- purchase cost: tee cost 900 (older, then 1000 latest received), mug 500, lamp has none ----
  const sup = (await request(t.app).post('/api/suppliers').set(h(admin)).send({ name: 'Acme' })).body.id;
  const buy = async (product: string, cost: number, ago: number) => {
    const po = await t.c.purchaseOrders.create({ supplierId: sup, warehouseId: ids.main.id, lines: [{ productId: product, quantity: 5, unitCostCents: cost }] }, null);
    await t.c.purchaseOrders.send(po.id); await t.c.purchaseOrders.receive(po.id, `r-${po.id}`, [{ productId: product, quantity: 5 }], null);
    await owner.query('UPDATE purchase_orders SET created_at = $2 WHERE id = $1', [po.id, dayAgo(ago)]);
  };
  await buy(tee, 900, 50); await buy(tee, 1000, 10); await buy(mug, 500, 10);
  // another business with its own, very different sales
  const B = await addTenant('an-other', 'Other');
  await runWithTenant(B, async () => {
    await t.c.auth.createUser({ email: 'b@b.test', password: 'Password123!', name: 'B', role: 'admin' });
    await t.pool.query("INSERT INTO products (sku, name, price_cents) VALUES ('B-ONLY', 'B only', 777)");
  });
  tokB = (await request(t.app).post('/api/auth/login').send({ email: 'b@b.test', password: 'Password123!' })).body.token;
});
afterAll(async () => { await owner.end(); await t.close(); });

describe('range handling', () => {
  it('defaults to the last 30 days and validates what it is given', () => {
    const r = resolveRange({}, new Date('2026-06-30T10:00:00Z'));
    expect(r).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    const why = (q: { from: string; to: string }) => { try { resolveRange(q); return ''; } catch (e) { return JSON.stringify((e as { details?: unknown }).details); } };
    expect(why({ from: '2026-06-10', to: '2026-06-01' })).toMatch(/after/);
    expect(why({ from: '2024-01-01', to: '2026-01-01' })).toMatch(/366/);
  });
  it('rejects malformed, impossible and unknown parameters with 400', async () => {
    for (const q of ['?from=yesterday', '?from=2026-02-30', '?from=2026-06-10&to=2026-06-01', '?from=2020-01-01&to=2026-01-01', '?foo=1', "?from=2026-01-01';DROP TABLE orders;--"]) {
      expect((await get(staff, `/sales${q}`)).status, q).toBe(400);
    }
    expect((await get(staff, '/dead-stock?days=2')).status).toBe(400);
    expect((await get(staff, '/best-sellers?limit=1000')).status).toBe(400);
  });
});

describe('sales', () => {
  it('by day (zero-filled), with totals that exclude cancelled orders and days outside the range', async () => {
    const res = await get(staff, `/sales?from=${dateStr(4)}&to=${dateStr(0)}`);
    expect(res.status).toBe(200);
    expect(res.body.days.map((d: { day: string }) => d.day)).toEqual([4, 3, 2, 1, 0].map(dateStr));
    const by = Object.fromEntries(res.body.days.map((d: { day: string; orders: number; units: number; revenueCents: number }) => [d.day, d]));
    expect(by[dateStr(1)]).toMatchObject({ orders: 2, units: 4, revenueCents: 5300 });
    expect(by[dateStr(3)]).toMatchObject({ orders: 2, units: 5, revenueCents: 8200 });     // the cancelled 9 lamps are not here
    expect(by[dateStr(2)]).toMatchObject({ orders: 0, units: 0, revenueCents: 0 });
    expect(res.body.totals).toEqual({ orders: 4, units: 9, revenueCents: 13500 });
  });

  it('by channel', async () => {
    const res = await get(staff, '/sales');
    expect(res.body.byChannel).toEqual([{ channel: 'whatsapp', orders: 2, revenueCents: 8800 }, { channel: 'web', orders: 1, revenueCents: 1500 }, { channel: 'telegram', orders: 1, revenueCents: 3200 }]
      .sort((a, b) => b.revenueCents - a.revenueCents || a.channel.localeCompare(b.channel)));
    expect(res.body.range.to).toBe(dateStr(0));
    expect(res.body.totals.orders).toBe(4);                                                // the 40-day-old order is outside the default window
  });

  it('best sellers by revenue then units', async () => {
    const res = await get(staff, '/best-sellers?limit=2');
    expect(res.body.products).toEqual([{ sku: 'LAMP', name: 'Lamp', units: 1, revenueCents: 5000 }, { sku: 'TEE', name: 'T-Shirt', units: 3, revenueCents: 4500 }]);
    const wide = await get(staff, `/best-sellers?from=${dateStr(60)}`);
    expect(wide.body.products.find((p: { sku: string }) => p.sku === 'TEE')).toMatchObject({ units: 8, revenueCents: 12000 });
  });
});

describe('dead stock', () => {
  it('lists stock that has not left for N days, never a product that sold recently', async () => {
    const res = await get(staff, '/dead-stock?days=60');
    expect(res.body.products.map((p: { sku: string }) => p.sku)).toEqual(['DUSTY']);
    expect(res.body.products[0]).toMatchObject({ inStock: 20, stockValueCents: 20_000, daysSinceSold: 100 });
    expect((await get(staff, '/dead-stock?days=200')).body.products).toEqual([]);          // its last movement was 100 days ago: not dead by a 200-day yardstick
  });

  it('does not flag a brand-new product or one that is out of stock', async () => {
    const fresh = (await request(t.app).post('/api/products').set(h(admin)).send({ sku: 'NEWBIE', name: 'New', priceCents: 100 })).body.id;
    await t.c.stock.receive({ productId: fresh, warehouseId: ids.main.id, quantity: 5 }, null);
    expect((await get(staff, '/dead-stock?days=30')).body.products.map((p: { sku: string }) => p.sku)).not.toContain('NEWBIE');
    expect((await get(staff, '/dead-stock?days=30')).body.products.every((p: { inStock: number }) => p.inStock > 0)).toBe(true);
  });
});

describe('margins', () => {
  it('uses the latest cost actually paid; products with no purchase history are reported as unknown, not guessed', async () => {
    const res = await get(staff, '/margins');
    const by = Object.fromEntries(res.body.products.map((p: { sku: string }) => [p.sku, p]));
    expect(by.TEE).toMatchObject({ units: 3, revenueCents: 4500, unitCostCents: 1000, costCents: 3000, marginCents: 1500, marginPct: 33.3 });   // 1000 is the newer cost
    expect(by.MUG).toMatchObject({ units: 5, revenueCents: 4000, unitCostCents: 500, costCents: 2500, marginCents: 1500, marginPct: 37.5 });
    expect(by.LAMP).toMatchObject({ units: 1, revenueCents: 5000, unitCostCents: null, costCents: null, marginCents: null, marginPct: null });
    expect(res.body.totals).toEqual({ revenueCents: 8500, costCents: 5500, marginCents: 3000, marginPct: 35.3, unknownCostProducts: 1 });
  });
});

describe('funnel', () => {
  it('chat → order → confirmed → paid, with rates', async () => {
    const res = await get(staff, '/funnel');
    expect(res.body).toMatchObject({ conversations: 3, orders: 3, confirmed: 2, paid: 1 });   // whatsapp x2 + telegram x1 (web is not chat; cancelled is not counted)
    expect(res.body.rates).toEqual({ conversationToOrder: 1, orderToConfirmed: 0.667, confirmedToPaid: 0.5 });
    const empty = await get(staff, `/funnel?from=${dateStr(300)}&to=${dateStr(290)}`);
    expect(empty.body).toMatchObject({ conversations: 0, orders: 0, confirmed: 0, paid: 0, rates: { conversationToOrder: null, orderToConfirmed: null, confirmedToPaid: null } });
  });
});

describe('access and isolation', () => {
  it('staff and admins only (margins show purchase costs); anonymous is refused', async () => {
    for (const p of ['/sales', '/best-sellers', '/dead-stock', '/margins', '/funnel']) {
      expect((await get(viewer, p)).status, p).toBe(403);
      expect((await get(staff, p)).status, p).toBe(200);
      expect((await get(admin, p)).status, p).toBe(200);
      expect((await request(t.app).get(`/api/analytics${p}`)).status, p).toBe(401);
    }
  });

  it('another business sees none of it', async () => {
    const sales = (await get(tokB, '/sales')).body;
    expect(sales.totals).toEqual({ orders: 0, units: 0, revenueCents: 0 });
    expect((await get(tokB, '/best-sellers')).body.products).toEqual([]);
    expect((await get(tokB, '/margins')).body.products).toEqual([]);
    expect((await get(tokB, '/funnel')).body).toMatchObject({ conversations: 0, orders: 0 });
    expect((await get(tokB, '/dead-stock?days=7')).body.products.map((p: { sku: string }) => p.sku)).not.toContain('DUSTY');
  });
});

describe('performance', () => {
  it('the queries use indexes: a year of data is planned without sequential scans of the big tables', async () => {
    const plan = (await owner.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT (created_at AT TIME ZONE 'UTC')::date, count(*) FROM orders WHERE status <> 'CANCELLED' AND tenant_id = '${DEFAULT}' AND created_at >= now() - interval '30 days' GROUP BY 1`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/idx_orders_tenant_created|Index|Bitmap/i);
  });
});
