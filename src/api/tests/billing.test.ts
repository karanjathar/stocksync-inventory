import { createHmac } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';

const WH_SECRET = 'platform-billing-webhook-secret';
let t: TestApp; let owner: pg.Pool; let platform: string; let A: string; let B: string; let adminA: string; let adminB: string; let staffA: string;
const calls: { method: string; path: string; body: Record<string, unknown>; auth: string }[] = [];
let n = 0;
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : {}, auth: new Headers(init?.headers).get('authorization') ?? '' });
  if (path === '/v1/subscriptions') { n++; return Response.json({ id: `sub_TEST${n}`, status: 'created', short_url: `https://rzp.io/i/sub${n}` }); }
  return Response.json({ id: 'sub_TEST', status: 'active' });
}) as typeof fetch;
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);
const mk = async (tenant: string, email: string, role: 'admin' | 'staff') => {
  await inTenant(tenant, () => t.c.auth.createUser({ email, password: 'Password123!', name: email, role }));
  return (await request(t.app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.token as string;
};
const hook = (event: string, sub: string, over: { plan?: string; end?: number; id?: string; secret?: string } = {}) => {
  const raw = JSON.stringify({ event, payload: { subscription: { entity: { id: sub, plan_id: over.plan ?? 'plan_PRO000001', status: 'active', current_end: over.end ?? Math.floor(Date.now() / 1000) + 30 * 86400 } } } });
  const sig = createHmac('sha256', over.secret ?? WH_SECRET).update(raw).digest('hex');
  return request(t.app).post('/webhooks/razorpay-billing').set('content-type', 'application/json').set('x-razorpay-signature', sig).set('x-razorpay-event-id', over.id ?? `evt_${Math.random()}`).send(raw);
};
const subRow = async (tenant: string) => (await owner.query('SELECT * FROM subscriptions WHERE tenant_id = $1', [tenant])).rows[0];
const planOf = async (tenant: string) => (await owner.query('SELECT plan FROM tenants WHERE id = $1', [tenant])).rows[0].plan as string;
const billing = (tok: string) => request(t.app).get('/api/billing').set(h(tok));

beforeAll(async () => {
  t = await buildTestApp({ RAZORPAY_PLATFORM_KEY_ID: 'rzp_test_platform', RAZORPAY_PLATFORM_KEY_SECRET: 'platform-secret-xyz', RAZORPAY_PLATFORM_WEBHOOK_SECRET: WH_SECRET,
    PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!' }, { fetch: fakeFetch });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  platform = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token;
  A = await addTenant('bill-a', 'Bill A'); B = await addTenant('bill-b', 'Bill B');
  adminA = await mk(A, 'admin@a.test', 'admin'); adminB = await mk(B, 'admin@b.test', 'admin'); staffA = await mk(A, 'staff@a.test', 'staff');
  // the operator links our plans to plans created in the platform's Razorpay account
  await request(t.app).put('/api/platform/plans/PRO').set(h(platform)).send({ razorpayPlanId: 'plan_PRO000001' });
  await request(t.app).put('/api/platform/plans/BUSINESS').set(h(platform)).send({ razorpayPlanId: 'plan_BIZ000001' });
});
afterAll(async () => { await owner.end(); await t.close(); });

describe('what the business sees', () => {
  it('offers only plans that cost money and are linked to Razorpay, with the trial length; admins only', async () => {
    const res = await billing(adminA);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, plan: { code: 'FREE' }, subscription: null, trialDays: 14, trialAvailable: true });
    expect(res.body.offers.map((o: { code: string }) => o.code)).toEqual(['PRO', 'BUSINESS']);
    expect(JSON.stringify(res.body)).not.toMatch(/plan_PRO000001|razorpay/i); // our Razorpay plan ids are not exposed
    expect((await request(t.app).get('/api/billing').set(h(staffA))).status).toBe(403);
    expect((await request(t.app).get('/api/billing')).status).toBe(401);
  });
});

describe('subscribing with a 14-day trial', () => {
  it('creates the Razorpay subscription from OUR plan record: no amount, our plan id, a future start for the trial, business id in notes', async () => {
    calls.length = 0;
    const res = await request(t.app).post('/api/billing/subscribe').set(h(adminA)).send({ plan: 'PRO' });
    expect(res.status).toBe(201);
    expect(res.body.shortUrl).toBe('https://rzp.io/i/sub1');
    const c = calls.find((x) => x.path === '/v1/subscriptions')!;
    expect(c.body).toMatchObject({ plan_id: 'plan_PRO000001', quantity: 1, notes: { tenant_id: A } });
    expect(c.body).not.toHaveProperty('amount');
    const days = ((c.body.start_at as number) * 1000 - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9); expect(days).toBeLessThan(14.1);
    expect(c.auth).toBe(`Basic ${Buffer.from('rzp_test_platform:platform-secret-xyz').toString('base64')}`);
    expect(await planOf(A)).toBe('FREE'); // nothing paid is unlocked by asking
    expect(await subRow(A)).toMatchObject({ status: 'CREATED', plan_code: 'PRO', trial_used: true });
  });

  it('ignores any price or Razorpay plan id sent by the caller', async () => {
    for (const body of [{ plan: 'PRO', amount: 1 }, { plan: 'PRO', razorpayPlanId: 'plan_EVIL00001' }, { plan: 'PRO', planId: 'x' }]) {
      expect((await request(t.app).post('/api/billing/subscribe').set(h(adminB)).send(body)).status).toBe(400);
    }
    for (const plan of ['FREE', 'NOPE', 'pro', 'ENTERPRISE']) expect([400, 409]).toContain((await request(t.app).post('/api/billing/subscribe').set(h(adminB)).send({ plan })).status);
    expect(await subRow(B)).toBeUndefined();
  });

  it('is for administrators and the business cannot write its own subscription', async () => {
    expect((await request(t.app).post('/api/billing/subscribe').set(h(staffA)).send({ plan: 'PRO' })).status).toBe(403);
    await expect(inTenant(A, () => t.pool.query("UPDATE subscriptions SET status = 'ACTIVE'"))).rejects.toMatchObject({ code: '42501' });
    await expect(inTenant(A, () => t.pool.query("INSERT INTO subscriptions (razorpay_subscription_id, plan_code, status) VALUES ('sub_FAKE1', 'PRO', 'ACTIVE')"))).rejects.toMatchObject({ code: '42501' });
    await expect(inTenant(A, () => t.pool.query('SELECT * FROM billing_events'))).rejects.toMatchObject({ code: '42501' });
    expect((await inTenant(B, () => t.pool.query('SELECT 1 FROM subscriptions'))).rowCount).toBe(0); // B cannot see A's
  });
});

describe('state changes only from signed webhooks', () => {
  it('rejects bad signatures, wrong secrets and unsigned calls; ignores unknown subscriptions', async () => {
    expect((await hook('subscription.charged', 'sub_TEST1', { secret: 'wrong-secret' })).status).toBe(401);
    expect((await request(t.app).post('/webhooks/razorpay-billing').send({ event: 'subscription.charged' })).status).toBe(401);
    expect((await request(t.app).post('/webhooks/razorpay-billing').set('x-razorpay-signature', 'abc').send('not json')).status).toBe(401);
    expect(await planOf(A)).toBe('FREE');
    expect((await hook('subscription.charged', 'sub_NOTOURS')).status).toBe(200); // acknowledged, nothing changes
    expect(await subRow(A)).toMatchObject({ status: 'CREATED' });
    expect((await hook('payment.captured', 'sub_TEST1')).status).toBe(200); // not a subscription event we handle
  });

  it('authenticated card → TRIAL with the paid plan; first charge → ACTIVE', async () => {
    expect((await hook('subscription.authenticated', 'sub_TEST1')).status).toBe(200);
    expect(await subRow(A)).toMatchObject({ status: 'TRIAL', plan_code: 'PRO' });
    expect(await planOf(A)).toBe('PRO');
    expect((await request(t.app).get('/api/usage').set(h(adminA))).body.plan.code).toBe('PRO'); // the limits follow immediately
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    expect((await hook('subscription.charged', 'sub_TEST1', { end })).status).toBe(200);
    const row = await subRow(A);
    expect(row.status).toBe('ACTIVE');
    expect(Math.abs(new Date(row.current_period_end).getTime() - end * 1000)).toBeLessThan(1000);
    expect((await billing(adminA)).body.subscription).toMatchObject({ status: 'ACTIVE', planCode: 'PRO', cancelAtPeriodEnd: false });
  });

  it('applies each event id once, even when Razorpay retries it', async () => {
    const id = 'evt_dup_1';
    expect((await hook('subscription.pending', 'sub_TEST1', { id })).status).toBe(200);
    const first = await subRow(A);
    expect(first.status).toBe('PAST_DUE');
    await hook('subscription.charged', 'sub_TEST1', { id: 'evt_between' }); // recovers
    expect((await subRow(A)).status).toBe('ACTIVE');
    await hook('subscription.pending', 'sub_TEST1', { id }); // the same event again: no effect
    expect((await subRow(A)).status).toBe('ACTIVE');
    expect((await owner.query("SELECT count(*)::int AS n FROM billing_events WHERE event_id = $1", [id])).rows[0].n).toBe(1);
  });

  it('a failed payment starts a grace period during which the paid plan stays; when it ends the business returns to Free and keeps its data', async () => {
    await hook('subscription.pending', 'sub_TEST1');
    const row = await subRow(A);
    expect(row.status).toBe('PAST_DUE');
    const days = (new Date(row.grace_ends_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9); expect(days).toBeLessThan(7.1);
    expect(await planOf(A)).toBe('PRO');
    await hook('subscription.halted', 'sub_TEST1'); // a later failure does not extend the grace period
    expect(new Date((await subRow(A)).grace_ends_at).getTime()).toBe(new Date(row.grace_ends_at).getTime());
    const product = await request(t.app).post('/api/products').set(h(adminA)).send({ sku: 'KEEP1', name: 'Kept', priceCents: 100 });
    expect(product.status).toBe(201);

    expect(await t.c.billingWebhooks!.expireGrace()).toBe(0); // still inside the grace period
    await owner.query("UPDATE subscriptions SET grace_ends_at = now() - interval '1 minute' WHERE tenant_id = $1", [A]);
    expect(await t.c.billingWebhooks!.expireGrace()).toBe(1);
    expect(await planOf(A)).toBe('FREE');
    expect((await subRow(A)).status).toBe('EXPIRED');
    expect((await request(t.app).get('/api/products').set(h(adminA))).body.map((p: { sku: string }) => p.sku)).toContain('KEEP1'); // data untouched
    expect(await t.c.billingWebhooks!.expireGrace()).toBe(0);
  });

  it('paying again after expiry restores the paid plan', async () => {
    await hook('subscription.charged', 'sub_TEST1');
    expect(await planOf(A)).toBe('PRO');
    expect(await subRow(A)).toMatchObject({ status: 'ACTIVE', grace_ends_at: null });
  });
});

describe('change plan and cancel', () => {
  it('asks Razorpay to change at the end of the cycle; the plan itself changes when the next charge arrives for it', async () => {
    calls.length = 0;
    expect((await request(t.app).post('/api/billing/change').set(h(adminA)).send({ plan: 'BUSINESS' })).status).toBe(200);
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/v1/subscriptions/sub_TEST1', body: { plan_id: 'plan_BIZ000001', schedule_change_at: 'cycle_end' } });
    expect(await planOf(A)).toBe('PRO');
    expect((await subRow(A)).pending_plan_code).toBe('BUSINESS');
    await hook('subscription.charged', 'sub_TEST1', { plan: 'plan_BIZ000001' });
    expect(await planOf(A)).toBe('BUSINESS');
    expect(await subRow(A)).toMatchObject({ plan_code: 'BUSINESS', pending_plan_code: null });
  });

  it('cancels at the end of the paid period; the Free plan applies when Razorpay confirms', async () => {
    calls.length = 0;
    const res = await request(t.app).post('/api/billing/cancel').set(h(adminA));
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.path.endsWith('/cancel'))).toMatchObject({ method: 'POST', path: '/v1/subscriptions/sub_TEST1/cancel', body: { cancel_at_cycle_end: 1 } });
    expect(res.body.subscription).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: true });
    expect(await planOf(A)).toBe('BUSINESS'); // paid for until the period ends
    await hook('subscription.cancelled', 'sub_TEST1');
    expect(await planOf(A)).toBe('FREE');
    expect((await subRow(A)).status).toBe('CANCELLED');
  });

  it('a second subscription gets no second trial', async () => {
    calls.length = 0;
    expect((await billing(adminA)).body.trialAvailable).toBe(false);
    const res = await request(t.app).post('/api/billing/subscribe').set(h(adminA)).send({ plan: 'PRO' });
    expect(res.status).toBe(201);
    expect(res.body.trialEndsAt).toBeNull();
    expect(calls.find((c) => c.path === '/v1/subscriptions')!.body).not.toHaveProperty('start_at');
  });

  it('refuses to start a second live subscription, and change/cancel need one', async () => {
    const sub = (await subRow(A)).razorpay_subscription_id as string;
    await hook('subscription.charged', sub);
    expect((await request(t.app).post('/api/billing/subscribe').set(h(adminA)).send({ plan: 'PRO' })).status).toBe(409);
    expect((await request(t.app).post('/api/billing/change').set(h(adminB)).send({ plan: 'PRO' })).status).toBe(404);
    expect((await request(t.app).post('/api/billing/cancel').set(h(adminB))).status).toBe(404);
  });

  it('businesses cannot touch each other: B never sees A\'s subscription and A\'s subscription id changes nothing in B', async () => {
    expect((await billing(adminB)).body.subscription).toBeNull();
    expect(await planOf(B)).toBe('FREE');
  });
});

describe('not configured', () => {
  it('answers 501 for actions and 503 for the webhook when platform billing keys are missing', async () => {
    const bare = await buildTestApp({});
    try {
      const tok = await bare.token('admin');
      expect((await request(bare.app).get('/api/billing').set(h(tok))).body.configured).toBe(false);
      expect((await request(bare.app).post('/api/billing/subscribe').set(h(tok)).send({ plan: 'PRO' })).status).toBe(501);
      expect((await request(bare.app).post('/webhooks/razorpay-billing').send({})).status).toBe(503);
    } finally { await bare.close(); }
  });
});
