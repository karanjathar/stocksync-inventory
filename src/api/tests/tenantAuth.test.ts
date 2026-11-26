import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { createPool } from '../src/db/pool.js';
import { runWithTenant } from '../src/db/tenant.js';

/** Login, tokens and the platform console across businesses (T91). */
let t: TestApp; let A: string; let B: string;
const plat = createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'stocksync_platform' }); // the platform console's database role
const SECRET = TEST_ENV.JWT_SECRET;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const login = (email: string, password = 'Password123!') => request(t.app).post('/api/auth/login').send({ email, password });
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);

beforeAll(async () => {
  t = await buildTestApp({ PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!' });
  A = await addTenant('shop-a', 'Shop A'); B = await addTenant('shop-b', 'Shop B');
  for (const [tenant, email] of [[A, 'owner@a.test'], [B, 'owner@b.test']] as const) {
    await inTenant(tenant, async () => {
      await t.c.auth.createUser({ email, password: 'Password123!', name: `Owner ${email}`, role: 'admin' });
      await t.c.repos.products.create({ sku: `ONLY-${tenant.slice(0, 4)}`, name: `Product of ${email}`, priceCents: 100 });
    });
  }
});
afterAll(async () => { await plat.end(); await t.close(); });

describe('login finds the business from the email', () => {
  it('each owner gets a token for their own business and sees only their own data', async () => {
    const a = await login('owner@a.test'); const b = await login('owner@b.test');
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(jwt.decode(a.body.token)).toMatchObject({ tid: A, typ: 'tenant', role: 'admin' });
    const la = await request(t.app).get('/api/products').set(h(a.body.token));
    expect(la.body.map((p: { name: string }) => p.name)).toEqual(['Product of owner@a.test']);
    const lb = await request(t.app).get('/api/products').set(h(b.body.token));
    expect(lb.body.map((p: { name: string }) => p.name)).toEqual(['Product of owner@b.test']);
    expect((await request(t.app).get('/api/users').set(h(a.body.token))).body.map((u: { email: string }) => u.email)).toEqual(['owner@a.test']);
  });

  it('a wrong password and an unknown email look the same', async () => {
    const bad = await login('owner@a.test', 'nope-nope-nope');
    const unknown = await login('nobody@nowhere.test');
    expect([bad.status, unknown.status]).toEqual([401, 401]);
    expect(bad.body).toEqual(unknown.body);
  });

  it('an email already used in another business cannot be registered, without saying where', async () => {
    const a = await login('owner@a.test');
    const res = await request(t.app).post('/api/users').set(h(a.body.token)).send({ email: 'owner@b.test', password: 'Password123!', name: 'Dup', role: 'staff' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toMatch(/shop-b|Shop B|tenant/i);
  });
});

describe('token confusion', () => {
  const sign = (claims: object, sub: string) => jwt.sign(claims, SECRET, { subject: sub, algorithm: 'HS256', expiresIn: '1h' });
  const userIdOf = async (tenant: string, email: string) => (await inTenant(tenant, () => t.c.repos.users.findByEmailWithHash(email)))!.id;

  it('a user id from business A with business B\'s tenant claim is refused', async () => {
    const idA = await userIdOf(A, 'owner@a.test');
    const forged = sign({ typ: 'tenant', tid: B, role: 'admin', email: 'owner@a.test' }, idA);
    expect((await request(t.app).get('/api/products').set(h(forged))).status).toBe(401);
  });

  it('tokens without a tenant claim or of the wrong type are refused', async () => {
    const idA = await userIdOf(A, 'owner@a.test');
    expect((await request(t.app).get('/api/products').set(h(sign({ email: 'owner@a.test', role: 'admin' }, idA)))).status).toBe(401);     // an old-style token
    expect((await request(t.app).get('/api/products').set(h(sign({ typ: 'platform', tid: A }, idA)))).status).toBe(401);
    expect((await request(t.app).get('/api/products').set(h(sign({ typ: 'tenant', tid: 'not-a-uuid' }, idA)))).status).toBe(401);
    expect((await request(t.app).get('/api/products').set(h(jwt.sign({ typ: 'tenant', tid: A }, 'another-secret'.padEnd(40, 'x'), { subject: idA })))).status).toBe(401);
  });
});

describe('suspended businesses', () => {
  it('cannot log in, and existing tokens stop working, until reinstated', async () => {
    const before = await login('owner@b.test');
    expect((await request(t.app).get('/api/products').set(h(before.body.token))).status).toBe(200);
    const ops = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token as string;
    const tenants = (await request(t.app).get('/api/platform/tenants').set(h(ops))).body as { id: string; slug: string }[];
    const bId = tenants.find((x) => x.slug === 'shop-b')!.id;
    expect((await request(t.app).patch(`/api/platform/tenants/${bId}`).set(h(ops)).send({ status: 'SUSPENDED' })).body.status).toBe('SUSPENDED');
    expect((await login('owner@b.test')).status).toBe(403);
    expect((await request(t.app).get('/api/products').set(h(before.body.token))).status).toBe(403);
    expect((await login('owner@a.test')).status).toBe(200); // other businesses are unaffected
    expect((await request(t.app).patch(`/api/platform/tenants/${bId}`).set(h(ops)).send({ status: 'ACTIVE' })).body.status).toBe('ACTIVE');
    expect((await login('owner@b.test')).status).toBe(200);
  });

  it('a wrong password on a suspended account does not reveal that it is suspended', async () => {
    const ops = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token as string;
    const bId = ((await request(t.app).get('/api/platform/tenants').set(h(ops))).body as { id: string; slug: string }[]).find((x) => x.slug === 'shop-b')!.id;
    await request(t.app).patch(`/api/platform/tenants/${bId}`).set(h(ops)).send({ status: 'SUSPENDED' });
    expect((await login('owner@b.test', 'wrong-wrong-wrong')).status).toBe(401);
    await request(t.app).patch(`/api/platform/tenants/${bId}`).set(h(ops)).send({ status: 'ACTIVE' });
  });
});

describe('the platform console', () => {
  const platformLogin = (email = 'ops@platform.test', password = 'PlatformPass123!') => request(t.app).post('/api/platform/login').send({ email, password });

  it('platform staff log in separately and list every business', async () => {
    const res = await platformLogin();
    expect(res.status).toBe(200);
    expect(jwt.decode(res.body.token)).toMatchObject({ typ: 'platform' });
    const list = await request(t.app).get('/api/platform/tenants').set(h(res.body.token));
    expect(list.body.map((x: { slug: string }) => x.slug)).toEqual(expect.arrayContaining(['default', 'shop-a', 'shop-b']));
    expect(list.body[0]).not.toHaveProperty('password_hash');
  });

  it('a business login does not open the console, and a platform login does not open any business data', async () => {
    const owner = (await login('owner@a.test')).body.token as string;
    const ops = (await platformLogin()).body.token as string;
    expect((await request(t.app).get('/api/platform/tenants').set(h(owner))).status).toBe(401);
    expect((await request(t.app).post('/api/platform/login').send({ email: 'owner@a.test', password: 'Password123!' })).status).toBe(401);
    for (const path of ['/api/products', '/api/orders', '/api/users', '/api/customers', '/api/settings']) {
      expect((await request(t.app).get(path).set(h(ops))).status, path).toBe(401);
    }
    expect((await request(t.app).get('/api/platform/tenants')).status).toBe(401);
    expect((await platformLogin('ops@platform.test', 'wrong')).status).toBe(401);
  });

  it('the platform database role cannot read business tables, even with raw SQL', async () => {
    await expect(plat.query('SELECT * FROM products')).rejects.toMatchObject({ code: '42501' });
    await expect(plat.query('SELECT * FROM users')).rejects.toMatchObject({ code: '42501' });
    await expect(plat.query('SELECT * FROM orders')).rejects.toMatchObject({ code: '42501' });
  });

  it('a business cannot read platform admins or change its own plan or status with SQL', async () => {
    await expect(inTenant(A, () => t.pool.query('SELECT * FROM platform_admins'))).rejects.toMatchObject({ code: '42501' });
    await expect(inTenant(A, () => t.pool.query("UPDATE tenants SET plan = 'BUSINESS'"))).rejects.toMatchObject({ code: '42501' });
    await expect(inTenant(A, () => t.pool.query("UPDATE tenants SET status = 'ACTIVE'"))).rejects.toMatchObject({ code: '42501' });
  });

  it('only ACTIVE and SUSPENDED can be set from the console, and unknown businesses are 404', async () => {
    const ops = (await platformLogin()).body.token as string;
    const id = ((await request(t.app).get('/api/platform/tenants').set(h(ops))).body as { id: string; slug: string }[])[0]!.id;
    expect((await request(t.app).patch(`/api/platform/tenants/${id}`).set(h(ops)).send({ status: 'DELETING' })).status).toBe(400);
    expect((await request(t.app).patch(`/api/platform/tenants/${id}`).set(h(ops)).send({ status: 'bogus' })).status).toBe(400);
    expect((await request(t.app).patch('/api/platform/tenants/00000000-0000-4000-8000-0000000000ff').set(h(ops)).send({ status: 'ACTIVE' })).status).toBe(404);
  });
});
