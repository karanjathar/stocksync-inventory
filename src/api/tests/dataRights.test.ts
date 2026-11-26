import pg from 'pg';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';
import { csvCell } from '../src/services/dataExport.js';

let t: TestApp; let owner: pg.Pool; let A: string; let B: string; let adminA: string; let adminB: string; let staffA: string;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);
const mk = async (tenant: string, email: string, role: 'admin' | 'staff') => {
  await inTenant(tenant, () => t.c.auth.createUser({ email, password: 'Password123!', name: email, role }));
  return (await request(t.app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.token as string;
};
const settle = () => new Promise((r) => setTimeout(r, 60));
const download = async (tok: string) => {
  const res = await request(t.app).post('/api/data/export').set(h(tok)).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (d: Buffer) => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  return { res, files: res.status === 200 ? unzipSync(new Uint8Array(res.body as Buffer)) : {} };
};
const text = (files: Record<string, Uint8Array>, name: string) => strFromU8(files[name]!);
let customerId = ''; let productA = '';

beforeAll(async () => {
  t = await buildTestApp({ ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!' });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  A = await addTenant('rights-a', 'Rights A'); B = await addTenant('rights-b', 'Rights B');
  await owner.query("UPDATE tenants SET plan = 'PRO' WHERE id = ANY($1)", [[A, B]]);
  adminA = await mk(A, 'admin@a.test', 'admin'); adminB = await mk(B, 'admin@b.test', 'admin'); staffA = await mk(A, 'staff@a.test', 'staff');
  const wh = (await request(t.app).post('/api/warehouses').set(h(adminA)).send({ code: 'W', name: 'W' })).body.id;
  productA = (await request(t.app).post('/api/products').set(h(adminA)).send({ sku: 'EXP1', name: '=HYPERLINK("http://evil","x")', priceCents: 4999 })).body.id;
  await inTenant(A, () => t.c.stock.receive({ productId: productA, warehouseId: wh, quantity: 9 }, null));
  customerId = (await request(t.app).post('/api/customers').set(h(adminA)).send({ name: 'Priya Sharma', phone: '+919876543210', email: 'priya@example.com' })).body.id;
  const order = (await request(t.app).post('/api/orders').set(h(adminA)).send({ customerId, channel: 'manual', items: [{ productId: productA, quantity: 2 }], notes: 'deliver to 12 MG Road' })).body;
  await inTenant(A, () => t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status) VALUES ('whatsapp','in','919876543210','my address is 12 MG Road','ok')"));
  await request(t.app).put('/api/channel-config/whatsapp').set(h(adminA)).send({ token: 'WA-SECRET-TOKEN-AAAA', phoneNumberId: '111' });
  await inTenant(B, () => t.pool.query("INSERT INTO products (sku, name, price_cents) VALUES ('B-ONLY', 'B product', 1)"));
  expect(order.totalCents).toBe(9998);
});
afterAll(async () => { await owner.end(); await t.close(); });

describe('csvCell', () => {
  it('quotes properly and defuses spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"'); expect(csvCell('say "hi"')).toBe('"say ""hi"""'); expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx']) expect(csvCell(bad).startsWith("'") || csvCell(bad).startsWith('"\'')).toBe(true);
    expect(csvCell(-5)).toBe('-5'); expect(csvCell(null)).toBe(''); expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('export', () => {
  it('streams a zip with one CSV per table of this business: all its data, none of anyone else\'s, no secrets', async () => {
    const { res, files } = await download(adminA);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="stocksync-export-rights-a-\d{4}-\d{2}-\d{2}\.zip"$/);
    const names = Object.keys(files);
    expect(names).toEqual(expect.arrayContaining(['products.csv', 'customers.csv', 'orders.csv', 'order_items.csv', 'stock_levels.csv', 'users.csv', 'audit_log.csv', 'manifest.json', 'README.txt']));
    const products = text(files, 'products.csv');
    expect(products.split('\n')[0]).toContain('sku');
    expect(products).toContain('EXP1');
    expect(products).toContain("'=HYPERLINK"); // formula neutralised
    expect(products).not.toContain('B-ONLY');
    expect(text(files, 'customers.csv')).toContain('Priya Sharma');
    const whole = names.map((n) => text(files, n)).join('\n');
    expect(whole).not.toMatch(/password_hash|\$2[aby]\$|WA-SECRET-TOKEN|b-only|B product/i);
    expect(names).not.toContain('tenant_channels.csv'); expect(names).not.toContain('jobs.csv');
    expect(text(files, 'users.csv')).not.toMatch(/password/i);
    const manifest = JSON.parse(text(files, 'manifest.json'));
    expect(manifest.business).toEqual({ slug: 'rights-a', name: 'Rights A' });
    expect(manifest.rows.products).toBe(1);
  });

  it('is admin only, audited, and each business exports only itself', async () => {
    expect((await request(t.app).post('/api/data/export').set(h(staffA))).status).toBe(403);
    expect((await request(t.app).post('/api/data/export')).status).toBe(401);
    await settle();
    const log = (await request(t.app).get('/api/audit-log?action=export').set(h(adminA))).body.entries;
    expect(log[0]).toMatchObject({ action: 'POST /data/export', actor: 'admin@a.test' });
    const b = await download(adminB);
    expect(text(b.files, 'products.csv')).toContain('B-ONLY');
    expect(text(b.files, 'products.csv')).not.toContain('EXP1');
  });

  it('copes with a table bigger than one batch (cursor paging) without holding it all', async () => {
    await inTenant(B, () => t.pool.query("INSERT INTO products (sku, name, price_cents) SELECT 'BULK' || g, 'Bulk ' || g, g FROM generate_series(1, 1300) g"));
    const { files } = await download(adminB);
    expect(text(files, 'products.csv').trim().split('\n')).toHaveLength(1 + 1 + 1300);
  });
});

describe('customer erasure', () => {
  it('drops name, contact details, notes and chat text but keeps the order and its amounts', async () => {
    const res = await request(t.app).post(`/api/data/customers/${customerId}/erase`).set(h(adminA));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ erased: true, messages: 1, orders: 1 });
    const c = (await inTenant(A, () => t.pool.query('SELECT name, phone, email, channel_user_id, gstin, erased_at FROM customers WHERE id = $1', [customerId]))).rows[0];
    expect(c).toMatchObject({ name: 'Erased customer', phone: null, email: null, channel_user_id: null, gstin: null });
    expect(c.erased_at).toBeTruthy();
    const order = (await inTenant(A, () => t.pool.query('SELECT total_cents, notes, status FROM orders WHERE customer_id = $1', [customerId]))).rows[0];
    expect(order).toMatchObject({ total_cents: 9998, notes: '', status: 'PENDING' });
    const msgs = (await inTenant(A, () => t.pool.query("SELECT text, external_user FROM channel_messages WHERE text LIKE '%MG Road%'"))).rows;
    expect(msgs).toEqual([]);
    await settle();
    expect(JSON.stringify((await request(t.app).get('/api/orders').set(h(adminA))).body)).not.toMatch(/Priya|9876543210|MG Road/);
  });

  it('is repeatable, audited, admin only and limited to the caller\'s own customers', async () => {
    expect((await request(t.app).post(`/api/data/customers/${customerId}/erase`).set(h(adminA))).body).toEqual({ erased: false, messages: 0, orders: 0 });
    expect((await request(t.app).post(`/api/data/customers/${customerId}/erase`).set(h(adminB))).status).toBe(404);
    expect((await request(t.app).post(`/api/data/customers/${customerId}/erase`).set(h(staffA))).status).toBe(403);
    await settle();
    expect((await request(t.app).get('/api/audit-log?action=erase').set(h(adminA))).body.entries[0]).toMatchObject({ action: 'POST /data/customers/:id/erase', entityId: customerId });
  });
});

describe('deleting a whole business', () => {
  const ask = (tok: string, body: object) => request(t.app).post('/api/data/deletion').set(h(tok)).send(body);

  it('needs the password and the web address, and starts a 30-day hold', async () => {
    expect((await ask(adminB, { password: 'wrong-password', confirmSlug: 'rights-b' })).status).toBe(401);
    expect((await ask(adminB, { password: 'Password123!', confirmSlug: 'someone-else' })).status).toBe(400);
    expect((await ask(staffA, { password: 'Password123!', confirmSlug: 'rights-a' })).status).toBe(403);
    expect((await request(t.app).get('/api/data/deletion').set(h(adminB))).body).toMatchObject({ requested: false, slug: 'rights-b' });
    const ok = await ask(adminB, { password: 'Password123!', confirmSlug: 'rights-b' });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ requested: true, holdDays: 30 });
    const days = (new Date(ok.body.eraseAfter).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9); expect(days).toBeLessThan(30.1);
    expect((await request(t.app).get('/api/products').set(h(adminB))).status).toBe(200); // still fully working during the hold
  });

  it('asking again does not restart the clock; cancelling clears it; a new request can follow', async () => {
    const first = (await request(t.app).get('/api/data/deletion').set(h(adminB))).body;
    const again = await ask(adminB, { password: 'Password123!', confirmSlug: 'rights-b' });
    expect(again.body.eraseAfter).toBe(first.eraseAfter);
    expect((await request(t.app).delete('/api/data/deletion').set(h(adminB))).body.requested).toBe(false);
    expect((await ask(adminB, { password: 'Password123!', confirmSlug: 'rights-b' })).body.requested).toBe(true);
    await request(t.app).delete('/api/data/deletion').set(h(adminB));
  });

  it('nothing is removed while the hold runs, even if the eraser is called', async () => {
    await ask(adminB, { password: 'Password123!', confirmSlug: 'rights-b' });
    expect(await t.c.tenantEraser!.runDue()).toBe(0);
    expect((await owner.query('SELECT 1 FROM tenants WHERE id = $1', [B])).rowCount).toBe(1);
    await expect(t.platformPool.query('SELECT tenant_erase($1)', [B])).rejects.toThrow(/no due deletion request/);
    await expect(inTenant(B, () => t.pool.query('SELECT tenant_erase($1)', [B]))).rejects.toMatchObject({ code: '42501' }); // the app role cannot call it at all
  });

  it('after the hold, removes every row and secret of that business and only that business, leaving a bare ledger line', async () => {
    const before = (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [A])).rows[0]!.n;
    await request(t.app).put('/api/channel-config/whatsapp').set(h(adminB)).send({ token: 'B-SECRET-TOKEN-BBBB', phoneNumberId: '222' });
    expect((await owner.query('SELECT 1 FROM tenant_channels WHERE tenant_id = $1', [B])).rowCount).toBe(1);
    await owner.query("UPDATE deletion_requests SET erase_after = now() - interval '1 minute' WHERE tenant_id = $1", [B]);
    expect(await t.c.tenantEraser!.runDue()).toBe(1);

    for (const table of ['users', 'products', 'tenant_channels', 'audit_log', 'settings', 'stock_levels', 'channel_messages', 'usage_counters', 'subscriptions', 'deletion_requests']) {
      expect((await owner.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [B])).rowCount, table).toBe(0);
    }
    expect((await owner.query('SELECT 1 FROM tenants WHERE id = $1', [B])).rowCount).toBe(0);
    expect((await owner.query('SELECT slug, rows_removed FROM tenant_deletions WHERE erased_tenant_id = $1', [B])).rows[0].rows_removed).toBeGreaterThan(1300);
    expect((await owner.query('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [A])).rows[0].n).toBe(before); // A untouched
    expect((await request(t.app).post('/api/auth/login').send({ email: 'admin@b.test', password: 'Password123!' })).status).toBe(401);
    expect((await request(t.app).get('/api/public/s/rights-b/catalog')).status).toBe(404);
    expect((await request(t.app).get('/api/products').set(h(adminB))).status).toBe(401);
    expect(await t.c.tenantEraser!.runDue()).toBe(0);
  });

  it('the original single-business tenant can never be erased', async () => {
    const def = '00000000-0000-4000-8000-000000000001';
    await owner.query("INSERT INTO deletion_requests (tenant_id, requested_by, erase_after) VALUES ($1, 'x', now() - interval '1 day')", [def]);
    await expect(t.platformPool.query('SELECT tenant_erase($1)', [def])).rejects.toThrow(/default business/);
    await owner.query('DELETE FROM deletion_requests WHERE tenant_id = $1', [def]);
    const admin = await t.token('admin');
    expect((await ask(admin, { password: 'Password123!', confirmSlug: 'default' })).status).toBeGreaterThanOrEqual(400);
  });
});
