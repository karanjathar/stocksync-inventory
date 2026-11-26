import pg from 'pg';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';

let t: TestApp; let owner: pg.Pool; let T: string;
const EMAIL = 'admin@sess.test'; const PASSWORD = 'Password123!';

/** A browser: keeps cookies, the way a real one would. */
class Browser {
  jar = new Map<string, string>();
  take(res: request.Response): void {
    for (const line of (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
      const [pair] = line.split(';'); const i = pair!.indexOf('='); const name = pair!.slice(0, i); const value = pair!.slice(i + 1);
      if (/expires=Thu, 01 Jan 1970/i.test(line) || value === '') this.jar.delete(name); else this.jar.set(name, decodeURIComponent(value));
    }
  }
  cookie(): string { return [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '); }
  async send(method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object, headers: Record<string, string> = {}, withCsrf = true) {
    const csrf = this.jar.get('ss_csrf');
    const req = request(t.app)[method](path).set('Cookie', this.cookie()).set(headers);
    if (withCsrf && csrf && method !== 'get') req.set('x-csrf-token', csrf);
    const res = await (body ? req.send(body) : req);
    this.take(res);
    return res;
  }
  async login(email = EMAIL, password = PASSWORD) { const res = await this.send('post', '/api/auth/login', { email, password }); return res; }
}
const setCookieLines = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[]) ?? []);

beforeAll(async () => {
  t = await buildTestApp({ PUBLIC_BASE_URL: 'https://app.example.com' });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  T = await addTenant('sess-biz', 'Sess');
  await runWithTenant(T, () => t.c.auth.createUser({ email: EMAIL, password: PASSWORD, name: 'Admin', role: 'admin' }));
});
afterAll(async () => { await owner.end(); await t.close(); });

describe('login cookies', () => {
  it('sets httpOnly Secure SameSite=Strict access and refresh cookies, and a script-readable CSRF cookie', async () => {
    const res = await request(t.app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookies = setCookieLines(res);
    const by = (n: string) => cookies.find((c) => c.startsWith(`${n}=`))!;
    for (const name of ['ss_access', 'ss_refresh']) expect(by(name)).toMatch(/HttpOnly/i);
    for (const name of ['ss_access', 'ss_refresh', 'ss_csrf']) { expect(by(name), name).toMatch(/Secure/i); expect(by(name), name).toMatch(/SameSite=Strict/i); }
    expect(by('ss_csrf')).not.toMatch(/HttpOnly/i);
    expect(by('ss_access')).toMatch(/Path=\/api(;|$)/); expect(by('ss_refresh')).toMatch(/Path=\/api\/auth/);
    expect(by('ss_refresh')).toMatch(/Max-Age=\d+/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.token).toBeTruthy(); // bearer for API clients
  });

  it('the cookie alone authenticates reads', async () => {
    const b = new Browser(); await b.login();
    const me = await b.send('get', '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(EMAIL);
  });

  it('bearer tokens keep working for API clients, without CSRF', async () => {
    const token = (await request(t.app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })).body.token;
    expect((await request(t.app).post('/api/categories').set('authorization', `Bearer ${token}`).send({ name: 'via bearer' })).status).toBe(201);
  });
});

describe('CSRF protection', () => {
  it('a cookie-authenticated change needs the matching token; reads do not', async () => {
    const b = new Browser(); await b.login();
    expect((await b.send('post', '/api/categories', { name: 'no token' }, {}, false)).status).toBe(403);
    expect((await b.send('post', '/api/categories', { name: 'wrong token' }, { 'x-csrf-token': 'abc.def' }, false)).status).toBe(403);
    expect((await b.send('post', '/api/categories', { name: 'good token' })).status).toBe(201);
    expect((await b.send('get', '/api/categories')).status).toBe(200);
  });

  it('a token from another session is refused, even though it is genuine', async () => {
    const a = new Browser(); const other = new Browser(); await a.login(); await other.login();
    const stolen = other.jar.get('ss_csrf')!;
    expect((await a.send('post', '/api/categories', { name: 'cross-session' }, { 'x-csrf-token': stolen }, false)).status).toBe(403);
  });

  it('a planted token (double submit from a cookie the attacker set) is refused: it is not signed for this session', async () => {
    const b = new Browser(); await b.login();
    b.jar.set('ss_csrf', 'attacker-chosen-value');
    expect((await b.send('post', '/api/categories', { name: 'planted' }, { 'x-csrf-token': 'attacker-chosen-value' }, false)).status).toBe(403);
  });
});

describe('refresh rotation', () => {
  it('each refresh issues new tokens; the access cookie works afterwards', async () => {
    const b = new Browser(); await b.login();
    const oldRefresh = b.jar.get('ss_refresh')!; const oldAccess = b.jar.get('ss_access')!;
    const r = await b.send('post', '/api/auth/refresh');
    expect(r.status).toBe(200);
    expect(b.jar.get('ss_refresh')).not.toBe(oldRefresh); expect(b.jar.get('ss_access')).not.toBe(oldAccess);
    expect((await b.send('get', '/api/auth/me')).status).toBe(200);
    expect((await b.send('post', '/api/categories', { name: 'after refresh' })).status).toBe(201); // and the new CSRF token works
  });

  it('replaying an old refresh token revokes the whole session family, including the thief\'s and the owner\'s newest', async () => {
    const owner1 = new Browser(); await owner1.login();
    const stolen = owner1.jar.get('ss_refresh')!;
    expect((await owner1.send('post', '/api/auth/refresh')).status).toBe(200); // the owner rotates normally
    const newest = owner1.jar.get('ss_refresh')!;
    const thief = new Browser(); thief.jar.set('ss_refresh', stolen);
    expect((await thief.send('post', '/api/auth/refresh')).status).toBe(401); // reuse detected
    // the family is dead: the owner's newest refresh token and access token no longer work
    const again = new Browser(); again.jar.set('ss_refresh', newest);
    expect((await again.send('post', '/api/auth/refresh')).status).toBe(401);
    expect((await owner1.send('get', '/api/auth/me')).status).toBe(401);
  });

  it('other sessions of the same user are not affected by one family\'s revocation', async () => {
    const phone = new Browser(); const laptop = new Browser(); await phone.login(); await laptop.login();
    const stolen = laptop.jar.get('ss_refresh')!;
    await laptop.send('post', '/api/auth/refresh');
    const thief = new Browser(); thief.jar.set('ss_refresh', stolen); await thief.send('post', '/api/auth/refresh');
    expect((await phone.send('get', '/api/auth/me')).status).toBe(200);
  });

  it('refuses unknown, malformed, expired and forged-tenant tokens with one plain 401 and clears the cookies', async () => {
    const other = await addTenant('sess-other', 'Other');
    for (const value of ['', 'garbage', `${T}.nope`, `${other}.${'x'.repeat(43)}`, 'x'.repeat(500), '../../etc']) {
      const b = new Browser(); if (value) b.jar.set('ss_refresh', value);
      const res = await b.send('post', '/api/auth/refresh');
      expect(res.status, value).toBe(401);
      expect(res.body.error.message).toBe('Session expired');
    }
    const b = new Browser(); await b.login();
    await owner.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL AND tenant_id = $1", [T]);
    const res = await b.send('post', '/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(setCookieLines(res).some((c) => c.startsWith('ss_refresh=;') || /ss_refresh=;/.test(c))).toBe(true);
  });

  it('keeps only hashes of refresh tokens in the database', async () => {
    const b = new Browser(); await b.login();
    const token = b.jar.get('ss_refresh')!;
    const rows = (await owner.query<{ token_hash: string }>('SELECT token_hash FROM refresh_tokens')).rows;
    expect(rows.some((r) => token.includes(r.token_hash) || r.token_hash === token)).toBe(false);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });

  it('a suspended business cannot refresh', async () => {
    const b = new Browser(); await b.login();
    await owner.query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [T]);
    try { expect((await b.send('post', '/api/auth/refresh')).status).toBeGreaterThanOrEqual(401); } finally { await owner.query("UPDATE tenants SET status = 'ACTIVE' WHERE id = $1", [T]); }
  });
});

describe('session fixation', () => {
  it('login ignores any session the browser already holds and issues entirely new ones; the planted family is untouched', async () => {
    const victim = new Browser(); await victim.login();
    const plantedRefresh = victim.jar.get('ss_refresh')!; const plantedAccess = victim.jar.get('ss_access')!;
    const attackerPlanted = new Browser(); attackerPlanted.jar.set('ss_refresh', plantedRefresh); attackerPlanted.jar.set('ss_access', plantedAccess); attackerPlanted.jar.set('ss_csrf', 'x');
    const res = await attackerPlanted.login();
    expect(res.status).toBe(200);
    expect(attackerPlanted.jar.get('ss_refresh')).not.toBe(plantedRefresh);
    expect(attackerPlanted.jar.get('ss_access')).not.toBe(plantedAccess);
    const families = (await owner.query<{ n: number }>('SELECT count(DISTINCT family_id)::int AS n FROM refresh_tokens WHERE tenant_id = $1', [T])).rows[0]!.n;
    expect(families).toBeGreaterThan(1); // a new family, not the planted one continued
    expect((await victim.send('get', '/api/auth/me')).status).toBe(200); // the victim's own session was not disturbed by someone else logging in
  });

  it('a failed login sets no cookies', async () => {
    const res = await request(t.app).post('/api/auth/login').send({ email: EMAIL, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(setCookieLines(res)).toEqual([]);
  });
});

describe('logout', () => {
  it('ends this session only: its cookies stop working, others continue', async () => {
    const a = new Browser(); const b = new Browser(); await a.login(); await b.login();
    const oldAccess = a.jar.get('ss_access')!; const oldRefresh = a.jar.get('ss_refresh')!;
    expect((await a.send('post', '/api/auth/logout')).status).toBe(204);
    expect(a.jar.has('ss_access')).toBe(false);
    const replay = new Browser(); replay.jar.set('ss_access', oldAccess); replay.jar.set('ss_csrf', b.jar.get('ss_csrf')!);
    expect((await replay.send('get', '/api/auth/me')).status).toBe(401); // the old access token is dead at once, not after its 15 minutes
    const rr = new Browser(); rr.jar.set('ss_refresh', oldRefresh);
    expect((await rr.send('post', '/api/auth/refresh')).status).toBe(401);
    expect((await b.send('get', '/api/auth/me')).status).toBe(200);
  });

  it('logout everywhere ends every session and every earlier bearer token of that user', async () => {
    const a = new Browser(); const b = new Browser(); await a.login(); await b.login();
    const bearer = (await request(t.app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })).body.token as string;
    expect((await a.send('post', '/api/auth/logout-all')).status).toBe(204);
    expect((await b.send('get', '/api/auth/me')).status).toBe(401);
    expect((await request(t.app).get('/api/auth/me').set('authorization', `Bearer ${bearer}`)).status).toBe(401);
    const fresh = new Browser(); expect((await fresh.login()).status).toBe(200); // signing in again works straight away
    expect((await fresh.send('get', '/api/auth/me')).status).toBe(200);
  });

  it('changing the password ends other sessions but keeps this browser signed in', async () => {
    const a = new Browser(); const b = new Browser(); await a.login(); await b.login();
    expect((await a.send('post', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'NewPassword456!' })).status).toBe(204);
    expect((await b.send('get', '/api/auth/me')).status).toBe(401);
    expect((await a.send('get', '/api/auth/me')).status).toBe(200);
    await a.send('post', '/api/auth/password', { currentPassword: 'NewPassword456!', newPassword: PASSWORD });
  });
});

describe('tokens cannot be confused', () => {
  it('a bearer token in the cookie slot, or a cookie token without a session, is refused', async () => {
    const bearer = (await request(t.app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })).body.token as string;
    const asCookie = await request(t.app).get('/api/auth/me').set('Cookie', `ss_access=${bearer}`); // no sid: not a browser session
    expect(asCookie.status).toBe(401);
    const forged = jwt.sign({ typ: 'tenant', tid: T, sid: '00000000-0000-4000-8000-000000000001', at: Date.now() }, TEST_ENV.JWT_SECRET, { subject: '00000000-0000-4000-8000-000000000002', algorithm: 'HS256', expiresIn: '5m' });
    expect((await request(t.app).get('/api/auth/me').set('Cookie', `ss_access=${forged}`)).status).toBe(401);
  });

  it('the first of two duplicate cookies wins, so a planted second one cannot override', async () => {
    const b = new Browser(); await b.login();
    const res = await request(t.app).get('/api/auth/me').set('Cookie', `${b.cookie()}; ss_access=planted`);
    expect(res.status).toBe(200);
  });
});

describe('invoices are not issued by GET', () => {
  it('a GET never creates an invoice, so a link or image on another site cannot cause one', async () => {
    await runWithTenant(T, async () => {
      await t.c.settings.update({ gst: { legalName: 'S Ltd', gstin: '27AAPFU0939F1ZV', address: 'x', stateCode: '27', invoicePrefix: 'SS', pricesIncludeTax: true } });
    });
    const b = new Browser(); await b.login();
    const wh = (await b.send('post', '/api/warehouses', { code: 'W', name: 'W' })).body.id;
    const prod = (await b.send('post', '/api/products', { sku: 'S1', name: 'S', priceCents: 100 })).body.id;
    await runWithTenant(T, () => t.c.stock.receive({ productId: prod, warehouseId: wh, quantity: 5 }, null));
    const cust = (await b.send('post', '/api/customers', { name: 'C' })).body.id;
    const order = (await b.send('post', '/api/orders', { customerId: cust, channel: 'manual', items: [{ productId: prod, quantity: 1 }] })).body.id;
    // The order is still PENDING (confirming it would issue the invoice by itself). GET must only read.
    expect((await b.send('get', `/api/orders/${order}/invoice`)).status).toBe(404);
    expect((await b.send('get', `/api/orders/${order}/invoice.pdf`)).status).toBe(404);
    expect((await owner.query('SELECT 1 FROM invoices WHERE order_id = $1', [order])).rowCount).toBe(0);
    expect((await b.send('post', `/api/orders/${order}/invoice`, undefined, {}, false)).status).toBe(403); // cookie + no CSRF token
    expect((await b.send('post', `/api/orders/${order}/invoice`)).status).toBe(409);                        // issuing is an explicit POST, and a pending order cannot be invoiced
    await b.send('post', `/api/orders/${order}/confirm`, { warehouseId: wh });
    expect((await b.send('get', `/api/orders/${order}/invoice`)).status).toBe(200);                         // confirming issued it; reading works now
  });
});
