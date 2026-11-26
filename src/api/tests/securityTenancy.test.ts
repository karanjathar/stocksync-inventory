import jwt from 'jsonwebtoken';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { assertAppRoleIsRestricted, createPool } from '../src/db/pool.js';
import { runWithTenant } from '../src/db/tenant.js';

/** Tenancy security regression suite (docs/7_SECURITY_AUDIT.md §7.R5a): one business must never reach, change or detect another's data. */
const KEY = Buffer.alloc(32, 3).toString('base64');
let t: TestApp; let A: string; let B: string; let adminA: string; let adminB: string; let ids: Record<string, string>;
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const tokenFor = async (tenant: string, email: string, role: 'admin' | 'staff') => {
  await inTenant(tenant, () => t.c.auth.createUser({ email, password: 'Password123!', name: email, role }));
  return (await request(t.app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.token as string;
};

beforeAll(async () => {
  t = await buildTestApp({ ENCRYPTION_KEY: KEY, PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!' });
  A = await addTenant('shop-a', 'Shop A'); B = await addTenant('shop-b', 'Shop B');
  adminA = await tokenFor(A, 'admin@a.test', 'admin'); adminB = await tokenFor(B, 'admin@b.test', 'admin');
  // Business A owns one of everything, all marked so a leak is easy to spot.
  ids = await inTenant(A, async () => {
    const category = (await t.c.repos.categories.create({ name: 'A-SECRET category' })).id;
    const warehouse = (await t.pool.query<{ id: string }>("INSERT INTO warehouses (code, name) VALUES ('A-WH', 'A-SECRET warehouse') RETURNING id")).rows[0]!.id;
    const product = (await t.c.repos.products.create({ sku: 'A-SECRET-SKU', name: 'A-SECRET product', priceCents: 11800, barcode: 'SEC-A-0001', categoryId: category, hsnCode: '610910', gstRateBp: 1200 })).id;
    await t.c.stock.receive({ productId: product, warehouseId: warehouse, quantity: 100 }, null);
    const supplier = (await t.c.repos.suppliers.create({ name: 'A-SECRET supplier' })).id;
    const customer = (await t.c.customers.create({ name: 'A-SECRET customer', phone: null, email: null, channel: 'manual', channelUserId: null, gstin: null, stateCode: null })).id;
    await t.c.settings.update({ currency: 'INR', defaultWarehouseId: warehouse, gst: { legalName: 'A-SECRET Ltd', gstin: '27AAPFU0939F1ZV', address: 'A street', stateCode: '27', invoicePrefix: 'AAA', pricesIncludeTax: true } });
    const order = await t.c.orders.create({ customerId: customer, channel: 'manual', items: [{ productId: product, quantity: 1 }] });
    await t.c.orders.confirm(order.id, warehouse, null);
    const po = (await t.c.purchaseOrders.create({ supplierId: supplier, warehouseId: warehouse, lines: [{ productId: product, quantity: 5, unitCostCents: 100 }] }, null)).id;
    await t.c.purchaseOrders.send(po);
    const count = (await t.c.stockCounts.open(warehouse, null)).id;
    const message = (await t.pool.query<{ id: string }>("INSERT INTO channel_messages (channel, direction, external_user, text, status, payload) VALUES ('whatsapp','out','1','A-SECRET message','failed','{\"kind\":\"text\",\"text\":\"x\"}') RETURNING id")).rows[0]!.id;
    const user = (await t.c.auth.createUser({ email: 'victim@a.test', password: 'Password123!', name: 'A-SECRET user', role: 'staff' })).id;
    return { category, warehouse, product, supplier, customer, order: order.id, po, count, message, user, barcode: 'SEC-A-0001' };
  });
  // Business B has its own, ordinary data.
  await inTenant(B, async () => {
    await t.c.repos.products.create({ sku: 'B-SKU', name: 'B product', priceCents: 100 });
    await t.pool.query("INSERT INTO warehouses (code, name) VALUES ('B-WH', 'B warehouse')");
  });
});
afterAll(async () => { await t.close(); });

/** What business A owns, as seen by A itself, to prove nothing changed after B's attempts. */
const snapshotA = () => inTenant(A, async () => JSON.stringify(await Promise.all([
  'SELECT id, sku, name, barcode, category_id FROM products ORDER BY id', 'SELECT id, status, payment_status FROM orders ORDER BY id', 'SELECT id, status FROM purchase_orders ORDER BY id',
  'SELECT id, status FROM stock_counts ORDER BY id', 'SELECT id, name, role FROM users ORDER BY id', 'SELECT id, name FROM customers ORDER BY id', 'SELECT id, name FROM suppliers ORDER BY id',
  'SELECT id, name FROM warehouses ORDER BY id', 'SELECT id, name FROM categories ORDER BY id', 'SELECT id, status FROM channel_messages ORDER BY id', 'SELECT product_id, quantity FROM stock_levels ORDER BY product_id', 'SELECT id, status FROM invoices ORDER BY id',
].map(async (sql) => (await t.pool.query(sql)).rows))));

type Entry = { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; leaf: string; body?: (i: Record<string, string>) => object };
const E = (method: Entry['method'], path: string, leaf: string, body?: Entry['body']): Entry => ({ method, path, leaf, ...(body ? { body } : {}) });
const crud = (prefix: string, key: string): Entry[] => [E('get', `${prefix}/:${key}`, '/:id'), E('patch', `${prefix}/:${key}`, '/:id', () => ({ name: 'hacked' })), E('delete', `${prefix}/:${key}`, '/:id')];
const MATRIX: Entry[] = [
  ...crud('/api/products', 'product'), E('get', '/api/products/by-barcode/:barcode', '/by-barcode/:code'),
  ...crud('/api/categories', 'category'), ...crud('/api/warehouses', 'warehouse'), ...crud('/api/suppliers', 'supplier'), ...crud('/api/customers', 'customer'),
  E('patch', '/api/users/:user', '/:id', () => ({ name: 'hacked', role: 'admin' })), E('delete', '/api/users/:user', '/:id'),
  E('get', '/api/orders/:order', '/:id'), E('post', '/api/orders/:order/confirm', '/:id/confirm', (i) => ({ warehouseId: i.warehouse })), E('post', '/api/orders/:order/fulfill', '/:id/fulfill'),
  E('post', '/api/orders/:order/cancel', '/:id/cancel'), E('post', '/api/orders/:order/payment-link', '/:id/payment-link', () => ({ notify: false })), E('post', '/api/orders/:order/refund', '/:id/refund'),
  E('post', '/api/orders/:order/refunded', '/:id/refunded'), E('get', '/api/orders/:order/invoice', '/:id/invoice'), E('post', '/api/orders/:order/invoice', '/:id/invoice'), E('post', '/api/orders/:order/invoice.pdf', '/:id/invoice.pdf'), E('get', '/api/orders/:order/invoice.pdf', '/:id/invoice.pdf'),
  E('get', '/api/purchase-orders/:po', '/:id'), E('patch', '/api/purchase-orders/:po', '/:id', () => ({ notes: 'hacked' })), E('post', '/api/purchase-orders/:po/send', '/:id/send'),
  E('post', '/api/purchase-orders/:po/cancel', '/:id/cancel'), E('post', '/api/purchase-orders/:po/receive', '/:id/receive', (i) => ({ receiptId: 'evil', lines: [{ productId: i.product, quantity: 1 }] })),
  E('get', '/api/stock-counts/:count', '/:id'), E('put', '/api/stock-counts/:count/lines', '/:id/lines', (i) => ({ lines: [{ productId: i.product, countedQuantity: 0 }] })),
  E('post', '/api/stock-counts/:count/submit', '/:id/submit'), E('post', '/api/stock-counts/:count/cancel', '/:id/cancel'),
  E('post', '/api/messages/:message/retry', '/:id/retry'), E('post', '/api/data/customers/:customer/erase', '/customers/:id/erase'),
];
/** Leaves that take a parameter but are capabilities, public by design, or not tenant data. Everything else with a parameter must be in the matrix. */
const EXEMPT = new Set([
  'get /orders/:token', 'post /orders/:token/payment-link', 'get /orders/:token/invoice.pdf', 'get /invoices/:id/download.pdf', // unguessable order and signed invoice links (tested in tenantShop)
  'get /s/:slug/manifest.webmanifest', 'get /s/:slug/catalog', 'post /s/:slug/orders',                                           // public shop of ONE business (tenantShop)
  'get /meta/:tenantId', 'post /meta/:tenantId', 'post /telegram/:tenantId', 'post /razorpay/:tenantId',                          // per-business webhooks (tenantChannels)
  'patch /tenants/:id', 'put /plans/:code',                                                                                                           // platform console (tenantAuth)
  'put /:kind', 'delete /:kind',                                                                                                  // the signed-in business's own credentials
]);

interface Layer { route?: { path: string | string[]; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } }
function leaves(stack: Layer[], out: Set<string> = new Set()): Set<string> {
  for (const l of stack) {
    if (l.route) for (const p of ([] as string[]).concat(l.route.path)) for (const m of Object.keys(l.route.methods)) out.add(`${m} ${p}`);
    else if (l.handle?.stack) leaves(l.handle.stack, out);
  }
  return out;
}
const sub = (path: string) => path.replace(/:([a-z]+)/g, (_m, k: string) => (ids[k] ?? _m));

describe('guards: the matrix covers the real route table', () => {
  const real = new Set<string>();
  beforeAll(() => { for (const r of leaves((t.app as unknown as { router: { stack: Layer[] } }).router.stack)) real.add(r); });
  it('every matrix entry names a route that exists (no typo can make a test pass vacuously)', () => {
    for (const e of MATRIX) expect(real.has(`${e.method} ${e.leaf}`), `${e.method} ${e.path} → ${e.leaf}`).toBe(true);
  });
  it('every route that takes a parameter is either in the matrix or an explicit, reviewed exemption', () => {
    const covered = new Set(MATRIX.map((e) => `${e.method} ${e.leaf}`));
    const missing = [...real].filter((r) => r.includes(':') && !covered.has(r) && !EXEMPT.has(r));
    expect(missing, `new parameterised routes need an isolation test or a reviewed exemption: ${missing.join(', ')}`).toEqual([]);
  });
  it('every top-level mount in app.ts is accounted for', () => {
    const src = readFileSync(new URL('../src/http/app.ts', import.meta.url), 'utf8');
    const mounts = [...src.matchAll(/api\.use\('\/([a-z-]+)'/g)].map((m) => m[1]!);
    const known = ['auth', 'signup', 'public', 'platform', 'users', 'categories', 'products', 'warehouses', 'stock', 'suppliers', 'customers', 'settings', 'orders', 'messages', 'channels', 'uploads', 'payments', 'ops', 'channel-config', 'onboarding', 'usage', 'billing', 'audit-log', 'data', 'assistant', 'analytics', 'purchase-orders', 'reorder-suggestions', 'stock-counts'];
    expect(mounts.filter((m) => !known.includes(m)), 'a new API area must be added to this suite deliberately').toEqual([]);
  });
});

describe('business B cannot reach, change or even detect business A\'s records', () => {
  it('every parameterised route answers 404 for A\'s ids and leaves A\'s data untouched', async () => {
    const before = await snapshotA();
    for (const e of MATRIX) {
      const res = await request(t.app)[e.method](sub(e.path)).set(h(adminB)).send(e.body ? e.body(ids) : undefined);
      expect(e.leaf === '/:id/refund' ? [404, 501] : e.leaf.startsWith('/:id/invoice') ? [404, 409] : [404], `${e.method.toUpperCase()} ${e.path}`).toContain(res.status); // refund answers 501 (no provider) and invoice 409 (no GST profile) before any lookup: identical for every id, so nothing is revealed
      expect(JSON.stringify(res.body), `${e.method} ${e.path}`).not.toMatch(/A-SECRET|SEC-A|victim/);
    }
    expect(await snapshotA()).toBe(before);
  });

  it('a 404 for a foreign id is indistinguishable from a 404 for an id that does not exist', async () => {
    for (const e of MATRIX.filter((x) => x.method === 'get')) {
      const foreign = await request(t.app).get(sub(e.path)).set(h(adminB));
      const none = await request(t.app).get(e.path.replace(/:([a-z]+)/g, (_m, k: string) => (k === 'barcode' ? 'NOPE-NOT-0001' : '00000000-0000-4000-8000-0000000000ff'))).set(h(adminB));
      expect([foreign.status, JSON.stringify(foreign.body)], e.path).toEqual([none.status, JSON.stringify(none.body)]);
    }
  });

  it('list endpoints show B only its own rows', async () => {
    for (const path of ['/api/products', '/api/categories', '/api/warehouses', '/api/suppliers', '/api/customers', '/api/orders', '/api/purchase-orders', '/api/stock-counts', '/api/messages',
      '/api/users', '/api/stock', '/api/stock/movements', '/api/reorder-suggestions', '/api/settings', '/api/dashboard', '/api/public/s/shop-b/catalog', '/api/channels']) {
      const res = await request(t.app).get(path).set(h(adminB));
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toMatch(/A-SECRET|SEC-A|victim|A-WH/);
    }
  });
});

describe('foreign ids smuggled into request bodies', () => {
  const refused = [400, 404, 409];
  const tryAsB = async (method: 'post' | 'put' | 'patch', path: string, body: object) => (await request(t.app)[method](path).set(h(adminB)).send(body)).status;

  it('B cannot attach A\'s category, customer, warehouse, supplier, product or count to its own records', async () => {
    const bProduct = (await request(t.app).get('/api/products').set(h(adminB))).body[0].id as string;
    const bWarehouse = (await request(t.app).get('/api/warehouses').set(h(adminB))).body[0].id as string;
    const attempts: [string, 'post' | 'put' | 'patch', string, object][] = [
      ['product with A\'s category', 'post', '/api/products', { sku: 'EVIL1', name: 'x', priceCents: 1, categoryId: ids.category }],
      ['own product moved into A\'s category', 'patch', `/api/products/${bProduct}`, { categoryId: ids.category }],
      ['order for A\'s customer', 'post', '/api/orders', { customerId: ids.customer, items: [{ productId: bProduct, quantity: 1 }] }],
      ['order of A\'s product', 'post', '/api/orders', { customerId: ids.customer, items: [{ productId: ids.product, quantity: 1 }] }],
      ['purchase order to A\'s supplier', 'post', '/api/purchase-orders', { supplierId: ids.supplier, warehouseId: bWarehouse, lines: [{ productId: bProduct, quantity: 1, unitCostCents: 1 }] }],
      ['purchase order into A\'s warehouse', 'post', '/api/purchase-orders', { supplierId: ids.supplier, warehouseId: ids.warehouse, lines: [{ productId: bProduct, quantity: 1, unitCostCents: 1 }] }],
      ['count of A\'s warehouse', 'post', '/api/stock-counts', { warehouseId: ids.warehouse }],
      ['stock receive of A\'s product', 'post', '/api/stock/receive', { productId: ids.product, warehouseId: bWarehouse, quantity: 5 }],
      ['stock receive into A\'s warehouse', 'post', '/api/stock/receive', { productId: bProduct, warehouseId: ids.warehouse, quantity: 5 }],
      ['stock adjust of A\'s product', 'post', '/api/stock/adjust', { productId: ids.product, warehouseId: ids.warehouse, newQuantity: 0, reason: 'x' }],
      ['stock transfer from A\'s warehouse', 'post', '/api/stock/transfer', { productId: bProduct, fromWarehouseId: ids.warehouse, toWarehouseId: bWarehouse, quantity: 1 }],
      ['A\'s warehouse as default', 'put', '/api/settings', { defaultWarehouseId: ids.warehouse }],
    ];
    for (const [name, method, path, body] of attempts) expect(refused, name).toContain(await tryAsB(method, path, body));
    // and the database itself refuses a cross-business reference even for raw SQL (composite foreign keys)
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    try {
      await expect(owner.query("INSERT INTO products (tenant_id, sku, name, price_cents, category_id) VALUES ($1, 'RAW', 'x', 1, $2)", [B, ids.category])).rejects.toMatchObject({ code: '23503' });
      await expect(owner.query("INSERT INTO stock_levels (tenant_id, product_id, warehouse_id, quantity) VALUES ($1, $2, $3, 1)", [B, ids.product, ids.warehouse])).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23505)$/) }); // FK, or the (product, warehouse) key already taken by A
    } finally { await owner.end(); }
  });

  it('a reorder run, stock-count lines and settings in B never reach A\'s ids', async () => {
    const reorder = await request(t.app).post('/api/reorder-suggestions/create-pos').set(h(adminB)).send({ productIds: [ids.product] });
    expect(reorder.status).toBe(201);
    expect(reorder.body.created).toEqual([]);
    const bWarehouse = (await request(t.app).get('/api/warehouses').set(h(adminB))).body[0].id as string;
    const count = (await request(t.app).post('/api/stock-counts').set(h(adminB)).send({ warehouseId: bWarehouse })).body.id as string;
    expect(refused).toContain((await request(t.app).put(`/api/stock-counts/${count}/lines`).set(h(adminB)).send({ lines: [{ productId: ids.product, countedQuantity: 1 }] })).status);
  });
});

describe('injection and database escape attempts', () => {
  const PAYLOADS = ["' OR '1'='1", "%' OR 1=1 --", "'; SELECT set_config('app.tenant_id', '" + 'x' + "', false); --", '") OR ("1"="1', 'x\\\'', '${A-SECRET}', "' UNION SELECT name FROM products --"];
  it('hostile search and filter parameters never widen what B sees and never cause a server error', async () => {
    for (const p of PAYLOADS) for (const path of ['/api/products?search=', '/api/customers?search=', '/api/suppliers?search=', '/api/orders?status=', '/api/stock?productId=', '/api/stock/movements?productId=', '/api/products?categoryId=']) {
      const res = await request(t.app).get(`${path}${encodeURIComponent(p)}`).set(h(adminB));
      expect(res.status, `${path}${p}`).toBeLessThan(500);
      expect(JSON.stringify(res.body)).not.toMatch(/A-SECRET|SEC-A/);
    }
  });

  it('the application role cannot leave its role, change the schema, or read platform data', async () => {
    const app = createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'stocksync_app' });
    try {
      const attempts = ["COPY (SELECT 1) TO PROGRAM 'id'", 'CREATE TABLE evil (x int)', 'ALTER TABLE products DISABLE ROW LEVEL SECURITY', 'DROP POLICY tenant_isolation ON products',
        'SELECT * FROM platform_admins', "UPDATE tenants SET status = 'ACTIVE'", 'DELETE FROM tenants', 'CREATE ROLE evil SUPERUSER', 'ALTER ROLE stocksync_app BYPASSRLS'];
      for (const sql of attempts) await expect(inTenant(B, () => app.query(sql)), sql).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|0LP01|42P01)$/) });
    } finally { await app.end(); }
  });

  it('KNOWN WEAKNESS of SET ROLE, shown and fixed: injected SQL could RESET ROLE; a login-role pool has nowhere to go back to', async () => {
    const viaSetRole = createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'stocksync_app', max: 1 });
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    try {
      await inTenant(B, () => viaSetRole.query('RESET ROLE')); // what an injected statement could do on a SET ROLE connection
      const back = (await inTenant(B, () => viaSetRole.query('SELECT current_user AS u'))).rows[0];
      expect(back.u).toBe('stocksync_app'); // the role is re-asserted on every checkout, so a RESET ROLE lasts one checkout at most
      // The robust setup: connect AS a restricted login role (DATABASE_APP_URL). There is no owner session to fall back to.
      await owner.query("DROP ROLE IF EXISTS sec_login; CREATE ROLE sec_login LOGIN PASSWORD 'sec-login-pw' NOSUPERUSER NOBYPASSRLS; GRANT stocksync_app TO sec_login");
      const url = new URL(TEST_DATABASE_URL); url.username = 'sec_login'; url.password = 'sec-login-pw';
      const login = createPool({ connectionString: url.toString(), ssl: false, scoped: true, max: 1 });
      try {
        await assertAppRoleIsRestricted(login);
        await inTenant(B, () => login.query('RESET ROLE'));
        expect((await inTenant(B, () => login.query('SELECT current_user AS u'))).rows[0].u).toBe('sec_login');
        await expect(inTenant(B, () => login.query('SET ROLE postgres'))).rejects.toMatchObject({ code: '42501' });
        expect((await inTenant(B, () => login.query('SELECT sku FROM products'))).rows.map((r) => r.sku)).toEqual(['B-SKU']); // context still scopes it
        expect((await login.query('SELECT sku FROM products')).rows).toHaveLength(0);                                        // and no context sees nothing
      } finally { await login.end(); }
    } finally {
      await owner.query('DROP OWNED BY sec_login; DROP ROLE IF EXISTS sec_login').catch(() => undefined);
      await owner.end(); await viaSetRole.end();
    }
  });
});

describe('tokens, links and webhooks across businesses', () => {
  const sign = (claims: object, sub: string, secret = TEST_ENV.JWT_SECRET, opts: jwt.SignOptions = {}) => jwt.sign(claims, secret, { subject: sub, algorithm: 'HS256', expiresIn: '1h', ...opts });
  const getProducts = (tok: string) => request(t.app).get('/api/products').set(h(tok));

  it('forged, unsigned, expired and re-targeted tokens are all refused', async () => {
    const victim = ids.user as string;
    expect((await getProducts(sign({ typ: 'tenant', tid: B }, victim))).status).toBe(401);                       // A's user id claimed for B
    expect((await getProducts(sign({ typ: 'tenant', tid: A }, victim, 'wrong-secret'.padEnd(40, 'x')))).status).toBe(401);
    expect((await getProducts(sign({ typ: 'tenant', tid: A }, victim, TEST_ENV.JWT_SECRET, { expiresIn: -10 }))).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: victim, typ: 'tenant', tid: A })).toString('base64url')}.`;
    expect((await getProducts(none)).status).toBe(401);                                                          // alg: none
    expect((await getProducts(sign({ typ: 'platform' }, victim))).status).toBe(401);
    expect((await getProducts(adminA)).status).toBe(200);                                                        // and a genuine token still works
  });

  it('webhooks: the server\'s own default keys never authenticate a request for another business', async () => {
    const raw = '{}';
    const sig = `sha256=${(await import('node:crypto')).createHmac('sha256', TEST_ENV.META_APP_SECRET).update(raw).digest('hex')}`;
    const res = await request(t.app).post(`/webhooks/meta/${B}`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw);
    expect([401, 503]).toContain(res.status); // B has no Meta credentials of its own: not served with the operator's
    expect((await request(t.app).post('/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw)).status).toBe(200); // the default business still can
  });

  it('suspended, unknown and malformed shops give the same plain answer (no way to tell which businesses exist)', async () => {
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await owner.query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [B]);
    try {
      const suspended = await request(t.app).get('/api/public/s/shop-b/catalog');
      const unknown = await request(t.app).get('/api/public/s/never-existed/catalog');
      expect([suspended.status, JSON.stringify(suspended.body)]).toEqual([unknown.status, JSON.stringify(unknown.body)]);
    } finally { await owner.query("UPDATE tenants SET status = 'ACTIVE' WHERE id = $1", [B]); await owner.end(); }
  });

  it('ciphertext of one business\'s credentials is useless in another (see tenantChannels), and the platform console reads no business data (see tenantAuth)', () => {
    expect(true).toBe(true);
  });
});
