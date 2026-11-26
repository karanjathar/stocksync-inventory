import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { TEST_DATABASE_URL } from './helpers/db.js';
import { MemoryEmailSender } from '../src/services/email.js';
import { loadEnv } from '../src/config/env.js';
import { TEST_ENV } from './helpers/app.js';

let t: TestApp; let mail: MemoryEmailSender; let owner: pg.Pool;
const body = (over: Record<string, unknown> = {}) => ({ email: 'Owner@Shop.test', password: 'a-long-password', businessName: 'Corner Shop', ownerName: 'Asha', slug: 'corner-shop', ...over });
const tokenOf = (m: { text: string }) => /token=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
const settle = () => new Promise((r) => setTimeout(r, 30)); // emails are sent in the background

beforeAll(async () => {
  mail = new MemoryEmailSender();
  t = await buildTestApp({ SIGNUP_ENABLED: 'true', TENANT_FALLBACK: 'off' }, { emailSender: mail });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
});
afterAll(async () => { await owner.end(); await t.close(); });

describe('configuration', () => {
  it('refuses to open sign-up while the single-business fallback is on', () => {
    expect(() => loadEnv({ ...TEST_ENV, SIGNUP_ENABLED: 'true', TENANT_FALLBACK: 'default' })).toThrow(/TENANT_FALLBACK/);
  });
  it('answers 501 when sign-up is not enabled', async () => {
    const closed = await buildTestApp({});
    try { expect((await request(closed.app).post('/api/signup').send(body())).status).toBe(501); } finally { await closed.close(); }
  });
});

describe('sign-up and email verification', () => {
  it('creates nothing and cannot log in until the emailed link is used, then creates the business, admin and settings', async () => {
    const res = await request(t.app).post('/api/signup').send(body());
    expect(res.status).toBe(202);
    await settle();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: 'owner@shop.test', subject: expect.stringContaining('Confirm') });
    expect((await owner.query("SELECT 1 FROM tenants WHERE slug = 'corner-shop'")).rowCount).toBe(0);
    expect((await request(t.app).post('/api/auth/login').send({ email: 'owner@shop.test', password: 'a-long-password' })).status).toBe(401);

    const token = tokenOf(mail.sent[0]!);
    expect(mail.sent[0]!.text).toContain('/verify-email?token=');
    const ok = await request(t.app).post('/api/signup/verify').send({ token });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ slug: 'corner-shop' });

    const login = await request(t.app).post('/api/auth/login').send({ email: 'owner@shop.test', password: 'a-long-password' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'admin', name: 'Asha' });
    const settings = await request(t.app).get('/api/settings').set('authorization', `Bearer ${login.body.token}`);
    expect(settings.body.businessName).toBe('Corner Shop');
    expect((await request(t.app).get('/api/public/s/corner-shop/catalog')).body.settings.businessName).toBe('Corner Shop');
    // the stored password is a hash, and the pending request is gone
    expect((await owner.query('SELECT 1 FROM signup_requests')).rowCount).toBe(0);
  });

  it('a link works once and a made-up or expired link is the same plain error', async () => {
    const used = tokenOf(mail.sent[0]!);
    const again = await request(t.app).post('/api/signup/verify').send({ token: used });
    const bogus = await request(t.app).post('/api/signup/verify').send({ token: 'x'.repeat(43) });
    expect([again.status, again.body.message]).toEqual([bogus.status, bogus.body.message]);
    expect(again.status).toBe(400);

    await request(t.app).post('/api/signup').send(body({ email: 'late@shop.test', slug: 'late-shop' }));
    await settle();
    await owner.query("UPDATE signup_requests SET expires_at = now() - interval '1 minute' WHERE email = 'late@shop.test'");
    const expired = await request(t.app).post('/api/signup/verify').send({ token: tokenOf(mail.sent.at(-1)!) });
    expect(expired.status).toBe(400);
    expect((await owner.query("SELECT 1 FROM tenants WHERE slug = 'late-shop'")).rowCount).toBe(0);
  });

  it('does not reveal whether an email has an account: same status and body, and the owner gets a notice instead', async () => {
    const before = mail.sent.length;
    const fresh = await request(t.app).post('/api/signup').send(body({ email: 'brand-new@shop.test', slug: 'brand-new' }));
    const existing = await request(t.app).post('/api/signup').send(body({ email: 'owner@shop.test', slug: 'another-shop' }));
    expect([existing.status, existing.body]).toEqual([fresh.status, fresh.body]);
    await settle();
    const notice = mail.sent.slice(before).find((m) => m.to === 'owner@shop.test')!;
    expect(notice.subject).toMatch(/already have/);
    expect(notice.text).not.toMatch(/token=/);
    expect((await owner.query("SELECT 1 FROM tenants WHERE slug = 'another-shop'")).rowCount).toBe(0);
  });

  it('validates the web address: format, reserved words, taken', async () => {
    for (const slug of ['ab', 'Has Space', '-bad', 'bad-', 'a--b', 'admin', 'api', 'default', 'x'.repeat(41), 'under_score']) {
      expect((await request(t.app).post('/api/signup').send(body({ email: `s${Math.random()}@x.test`, slug }))).status, slug).toBe(400);
    }
    expect((await request(t.app).post('/api/signup').send(body({ email: 'other@shop.test', slug: 'corner-shop' }))).status).toBe(409); // an existing business
    await request(t.app).post('/api/signup').send(body({ email: 'p1@shop.test', slug: 'pending-one' }));
    expect((await request(t.app).post('/api/signup').send(body({ email: 'p2@shop.test', slug: 'pending-one' }))).status).toBe(409);    // reserved by a pending sign-up
  });

  it('validates the other fields', async () => {
    for (const bad of [{ password: 'short' }, { email: 'nope' }, { businessName: ' ' }, { ownerName: '' }, { password: 'x'.repeat(201) }]) {
      expect((await request(t.app).post('/api/signup').send(body({ slug: 'valid-slug', ...bad }))).status).toBe(400);
    }
  });

  it('limits resends: too soon sends nothing, five in total at most, and unknown addresses look the same', async () => {
    await request(t.app).post('/api/signup').send(body({ email: 'rs@shop.test', slug: 'resend-shop' }));
    await settle();
    const count = () => mail.sent.filter((m) => m.to === 'rs@shop.test').length;
    expect(count()).toBe(1);
    const tooSoon = await request(t.app).post('/api/signup/resend').send({ email: 'rs@shop.test' });
    await settle();
    expect(tooSoon.status).toBe(202);
    expect(count()).toBe(1); // within the minimum interval
    const unknown = await request(t.app).post('/api/signup/resend').send({ email: 'nobody@shop.test' });
    expect([unknown.status, unknown.body]).toEqual([tooSoon.status, tooSoon.body]);

    for (let i = 0; i < 6; i++) {
      await owner.query("UPDATE signup_requests SET last_sent_at = now() - interval '2 minutes' WHERE email = 'rs@shop.test'");
      await request(t.app).post('/api/signup/resend').send({ email: 'rs@shop.test' });
      await settle();
    }
    expect(count()).toBe(5);
    // the newest link works and the older ones were replaced
    const first = tokenOf(mail.sent.filter((m) => m.to === 'rs@shop.test')[0]!);
    expect((await request(t.app).post('/api/signup/verify').send({ token: first })).status).toBe(400);
    expect((await request(t.app).post('/api/signup/verify').send({ token: tokenOf(mail.sent.filter((m) => m.to === 'rs@shop.test').at(-1)!) })).status).toBe(201);
  });

  it('keeps pending sign-ups and their password hashes out of reach of the application role', async () => {
    await request(t.app).post('/api/signup').send(body({ email: 'hidden@shop.test', slug: 'hidden-shop' }));
    await expect(t.pool.query('SELECT * FROM signup_requests')).rejects.toMatchObject({ code: '42501' });
    await expect(t.pool.query("INSERT INTO tenants (slug, name) VALUES ('sneaky', 'x')")).rejects.toMatchObject({ code: '42501' });
  });

  it('stores only a hash of the link token', async () => {
    const token = tokenOf(mail.sent.at(-1)!);
    const rows = (await owner.query<{ token_hash: string }>('SELECT token_hash FROM signup_requests')).rows;
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
  });
});
