import { createHmac } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { loadEnv } from '../src/config/env.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';
import { SecretBox } from '../src/services/secrets.js';
import { paidLinkEvent } from './helpers/fakeRazorpay.js';

const KEY1 = Buffer.alloc(32, 7).toString('base64');
const KEY2 = Buffer.alloc(32, 9).toString('base64');

describe('SecretBox (AES-256-GCM, bound to the business)', () => {
  const box = new SecretBox([{ version: 1, key: Buffer.from(KEY1, 'base64') }], 1);
  it('round-trips, never repeats a ciphertext, and keeps the plaintext out of it', () => {
    const a = box.encrypt('{"token":"super-secret-token"}', 'tenant-a'); const b = box.encrypt('{"token":"super-secret-token"}', 'tenant-a');
    expect(box.decrypt(a, 'tenant-a')).toBe('{"token":"super-secret-token"}');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('latin1')).not.toContain('super-secret');
  });
  it('refuses another business\'s ciphertext, tampering and truncation', () => {
    const enc = box.encrypt('hello', 'tenant-a');
    expect(() => box.decrypt(enc, 'tenant-b')).toThrow();
    const tampered = Buffer.from(enc); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => box.decrypt(tampered, 'tenant-a')).toThrow();
    expect(() => box.decrypt(enc.subarray(0, 20), 'tenant-a')).toThrow();
    expect(() => box.decrypt(Buffer.alloc(0), 'tenant-a')).toThrow();
  });
  it('reads data written with an older key and reports it needs re-encrypting after a rotation', () => {
    const old = box.encrypt('rotate me', 'tenant-a');
    const rotated = new SecretBox([{ version: 2, key: Buffer.from(KEY2, 'base64') }, { version: 1, key: Buffer.from(KEY1, 'base64') }], 2);
    expect(rotated.decrypt(old, 'tenant-a')).toBe('rotate me');
    expect(rotated.needsRotation(old)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('x', 'tenant-a'))).toBe(false);
    expect(() => new SecretBox([{ version: 1, key: Buffer.alloc(16) }], 1)).toThrow(/32 bytes/);
  });
});

/** Credentials per business, webhooks routed to them, and nobody using another business's keys. */
let t: TestApp; let A: string; let B: string; let adminA: string; let adminB: string; let staffA: string;
const fetchCalls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  fetchCalls.push({ url, auth: new Headers(init?.headers).get('authorization') ?? '', body: init?.body ? JSON.parse(String(init.body)) : {} });
  if (url.includes('/payment_links')) return Response.json({ id: 'plink_t1', short_url: 'https://rzp.io/i/t1', status: 'created' });
  return Response.json({ messages: [{ id: 'wamid.X' }], result: { message_id: 1 } });
}) as typeof fetch;
const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithTenant(id, fn);
const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
const signMeta = (raw: string, secret: string) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const tokenFor = async (tenant: string, email: string, role: 'admin' | 'staff') => {
  await inTenant(tenant, () => t.c.auth.createUser({ email, password: 'Password123!', name: email, role }));
  return (await request(t.app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.token as string;
};

beforeAll(async () => {
  t = await buildTestApp({ ENCRYPTION_KEY: KEY1, PUBLIC_BASE_URL: 'https://app.example.com' }, { fetch: fakeFetch });
  A = await addTenant('shop-a', 'Shop A'); B = await addTenant('shop-b', 'Shop B');
  adminA = await tokenFor(A, 'admin@a.test', 'admin'); adminB = await tokenFor(B, 'admin@b.test', 'admin'); staffA = await tokenFor(A, 'staff@a.test', 'staff');
});
afterAll(async () => { await t.close(); });

const put = (tok: string, kind: string, body: object) => request(t.app).put(`/api/channel-config/${kind}`).set(h(tok)).send(body);
const A_CFG = { meta: { appSecret: 'a-app-secret-0001', verifyToken: 'a-verify-token' }, whatsapp: { token: 'A-WA-TOKEN-1111', phoneNumberId: '111' },
  telegram: { botToken: 'A-TG-TOKEN', webhookSecret: 'a-tg-secret' }, razorpay: { keyId: 'rzp_test_AAAA', keySecret: 'a-rzp-secret', webhookSecret: 'a-rzp-hook' } };
const B_CFG = { meta: { appSecret: 'b-app-secret-0002', verifyToken: 'b-verify-token' }, whatsapp: { token: 'B-WA-TOKEN-2222', phoneNumberId: '222' },
  telegram: { botToken: 'B-TG-TOKEN', webhookSecret: 'b-tg-secret' }, razorpay: { keyId: 'rzp_test_BBBB', keySecret: 'b-rzp-secret', webhookSecret: 'b-rzp-hook' } };

describe('storing credentials', () => {
  it('admins save each kind; the API never returns a secret, only whether it is set and the last four characters', async () => {
    for (const [kind, cfg] of Object.entries(A_CFG)) expect((await put(adminA, kind, cfg)).status, kind).toBe(200);
    for (const [kind, cfg] of Object.entries(B_CFG)) expect((await put(adminB, kind, cfg)).status, kind).toBe(200);
    const res = await request(t.app).get('/api/channel-config').set(h(adminA));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const secret of ['a-app-secret-0001', 'A-WA-TOKEN-1111', 'A-TG-TOKEN', 'a-rzp-secret', 'a-rzp-hook', 'a-tg-secret', 'a-verify-token']) expect(text).not.toContain(secret);
    expect(res.body.tenantId).toBe(A);
    expect(res.body.urls).toEqual({ meta: `https://app.example.com/webhooks/meta/${A}`, telegram: `https://app.example.com/webhooks/telegram/${A}`, razorpay: `https://app.example.com/webhooks/razorpay/${A}` });
    expect(res.body.kinds.find((k: { kind: string }) => k.kind === 'whatsapp')).toMatchObject({ configured: true, hint: '1111' });
    expect(JSON.stringify((await request(t.app).get('/api/channel-config').set(h(adminB))).body)).not.toContain('A-WA-TOKEN');
  });

  it('only admins may read or change them, and bad input is refused', async () => {
    expect((await request(t.app).get('/api/channel-config').set(h(staffA))).status).toBe(403);
    expect((await put(staffA, 'whatsapp', A_CFG.whatsapp)).status).toBe(403);
    expect((await request(t.app).get('/api/channel-config')).status).toBe(401);
    expect((await put(adminA, 'whatsapp', { token: '', phoneNumberId: 'abc' })).status).toBe(400);
    expect((await put(adminA, 'whatsapp', { token: 'x'.repeat(5000), phoneNumberId: '1' })).status).toBe(400);
    expect((await put(adminA, 'nonsense', {})).status).toBe(400);
    expect((await put(adminA, 'razorpay', { keyId: 'live_key', keySecret: 's', webhookSecret: 'w' })).status).toBe(400); // must look like rzp_…
  });

  it('keeps ciphertext in the database, bound to the business: a copy in another business cannot be read', async () => {
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    try {
      const raw = (await owner.query("SELECT config_encrypted FROM tenant_channels WHERE tenant_id = $1 AND kind = 'whatsapp'", [A])).rows[0].config_encrypted as Buffer;
      expect(raw.toString('latin1')).not.toContain('A-WA-TOKEN');
      await owner.query("UPDATE tenant_channels SET config_encrypted = $1 WHERE tenant_id = $2 AND kind = 'whatsapp'", [raw, B]); // A's ciphertext planted in B
      t.c.channelCredentials.clearCache();
      expect(await inTenant(B, () => t.c.channelCredentials.get('whatsapp'))).toBeUndefined();   // unreadable, so treated as not configured
      expect(await inTenant(A, () => t.c.channelCredentials.get('whatsapp'))).toMatchObject({ token: 'A-WA-TOKEN-1111' });
    } finally { await owner.end(); }
    await put(adminB, 'whatsapp', B_CFG.whatsapp); // restore B
    t.c.channelCredentials.clearCache();
  });

  it('is refused (501) when no encryption key is configured', async () => {
    // A second app on the SAME database (never reset the DB inside a test file), started without ENCRYPTION_KEY.
    const bare = createApp(createContainer({ env: loadEnv({ ...TEST_ENV }), pool: t.pool }));
    expect((await request(bare).put('/api/channel-config/whatsapp').set(h(adminA)).send(A_CFG.whatsapp)).status).toBe(501);
    expect((await request(bare).get('/api/channel-config').set(h(adminA))).body.enabled).toBe(false);
  });
});

describe('each business sends with its own keys', () => {
  it('WhatsApp messages use the sender\'s own token and phone number id', async () => {
    fetchCalls.length = 0;
    await inTenant(A, () => t.c.hub.send('whatsapp', '15550001', 'from A'));
    await inTenant(B, () => t.c.hub.send('whatsapp', '15550002', 'from B'));
    const a = fetchCalls.find((c) => JSON.stringify(c.body).includes('from A'))!; const b = fetchCalls.find((c) => JSON.stringify(c.body).includes('from B'))!;
    expect(a.url).toContain('/111/messages'); expect(a.auth).toBe('Bearer A-WA-TOKEN-1111');
    expect(b.url).toContain('/222/messages'); expect(b.auth).toBe('Bearer B-WA-TOKEN-2222');
  });

  it('a business with no credentials of its own sends nothing, and never borrows another business\'s or the server\'s', async () => {
    const C = await addTenant('shop-c', 'Shop C');
    fetchCalls.length = 0;
    await inTenant(C, () => t.c.hub.send('whatsapp', '15550003', 'from C'));
    expect(fetchCalls).toHaveLength(0);
    expect((await inTenant(C, () => t.pool.query("SELECT status FROM channel_messages WHERE text = 'from C'"))).rows[0].status).toBe('skipped');
    expect((await inTenant(C, () => t.c.hub.status())).every((s) => !s.configured)).toBe(true);
  });

  it('online payments use the business\'s own Razorpay keys, and are unavailable without them', async () => {
    const wh = (tenant: string) => inTenant(tenant, async () => {
      const w = (await t.pool.query<{ id: string }>("INSERT INTO warehouses (code, name) VALUES ('MAIN','Main') RETURNING id")).rows[0]!.id;
      const p = await t.c.repos.products.create({ sku: 'RZP', name: 'Item', priceCents: 30000 });
      await t.c.stock.receive({ productId: p.id, warehouseId: w, quantity: 5 }, null);
      await t.c.settings.update({ currency: 'INR', defaultWarehouseId: w });
      const customer = await t.c.customers.findOrCreateByChannel('web', '9100', 'Pay');
      return t.c.orders.create({ customerId: customer.id, channel: 'web', paymentMethod: 'ONLINE', items: [{ productId: p.id, quantity: 1 }] });
    });
    const orderA = await wh(A);
    fetchCalls.length = 0;
    await inTenant(A, () => t.c.payments.linkForOrder(orderA.id));
    expect(fetchCalls.find((c) => c.url.includes('/payment_links'))!.auth).toBe(`Basic ${Buffer.from('rzp_test_AAAA:a-rzp-secret').toString('base64')}`);
    const D = await addTenant('shop-d', 'Shop D');
    expect((await inTenant(D, () => t.c.payments.config())).razorpayConfigured).toBe(false);
  });
});

describe('webhooks reach the right business and are verified with its own secret', () => {
  const metaPost = (tenant: string, secret: string, text: string, from = '15551230000') => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: `wamid.${text}`, from, type: 'text', text: { body: text } }] } }] }] });
    return request(t.app).post(`/webhooks/meta/${tenant}`).set('content-type', 'application/json').set('x-hub-signature-256', signMeta(raw, secret)).send(raw);
  };

  it('Meta: the handshake uses each business\'s own verify token', async () => {
    const ok = await request(t.app).get(`/webhooks/meta/${A}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'a-verify-token', 'hub.challenge': '777' });
    expect([ok.status, ok.text]).toEqual([200, '777']);
    expect((await request(t.app).get(`/webhooks/meta/${A}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'b-verify-token', 'hub.challenge': '1' })).status).toBe(403);
    expect((await request(t.app).get(`/webhooks/meta/${B}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'b-verify-token', 'hub.challenge': '2' })).text).toBe('2');
  });

  it('Meta: a message signed with A\'s secret lands in A\'s inbox only, and B\'s secret is refused on A\'s URL', async () => {
    expect((await metaPost(A, 'a-app-secret-0001', 'hello-a')).status).toBe(200);
    expect((await inTenant(A, () => t.pool.query("SELECT 1 FROM channel_messages WHERE text = 'hello-a' AND direction = 'in'"))).rowCount).toBe(1);
    expect((await inTenant(B, () => t.pool.query("SELECT 1 FROM channel_messages WHERE text = 'hello-a'"))).rowCount).toBe(0);
    expect((await metaPost(A, 'b-app-secret-0002', 'forged-for-a')).status).toBe(401);
    expect((await inTenant(A, () => t.pool.query("SELECT 1 FROM channel_messages WHERE text = 'forged-for-a'"))).rowCount).toBe(0);
  });

  it('Telegram: each business has its own secret header', async () => {
    const tg = (tenant: string, secret: string) => request(t.app).post(`/webhooks/telegram/${tenant}`).set('x-telegram-bot-api-secret-token', secret)
      .send({ update_id: 1, message: { message_id: 1, chat: { id: 55 }, from: { first_name: 'T' }, text: 'ping' } });
    expect((await tg(A, 'a-tg-secret')).status).toBe(200);
    expect((await tg(A, 'b-tg-secret')).status).toBe(401);
    expect((await tg(B, 'b-tg-secret')).status).toBe(200);
  });

  it('Razorpay: a payment is settled with the business\'s own webhook secret', async () => {
    const order = (await inTenant(A, () => t.pool.query<{ id: string }>("SELECT id FROM orders WHERE payment_method = 'ONLINE' LIMIT 1"))).rows[0]!;
    const plink = (await inTenant(A, () => t.pool.query<{ provider_ref: string }>('SELECT provider_ref FROM payments WHERE order_id = $1', [order.id]))).rows[0]!.provider_ref;
    const raw = JSON.stringify(paidLinkEvent(plink, 30000));
    const post = (tenant: string, secret: string, id: string) => request(t.app).post(`/webhooks/razorpay/${tenant}`).set('content-type', 'application/json')
      .set('x-razorpay-signature', createHmac('sha256', secret).update(raw).digest('hex')).set('x-razorpay-event-id', id).send(raw);
    expect((await post(A, 'b-rzp-hook', 'evt_wrong')).status).toBe(401);
    expect((await inTenant(A, () => t.pool.query('SELECT payment_status FROM orders WHERE id = $1', [order.id]))).rows[0].payment_status).toBe('UNPAID');
    expect((await post(B, 'a-rzp-hook', 'evt_cross')).status).toBe(401);
    expect((await post(A, 'a-rzp-hook', 'evt_ok')).status).toBe(200);
    expect((await inTenant(A, () => t.pool.query('SELECT payment_status FROM orders WHERE id = $1', [order.id]))).rows[0].payment_status).toBe('PAID');
  });

  it('unknown, malformed and suspended businesses are 404, and a business without that channel configured answers 503', async () => {
    const raw = '{}';
    const sig = signMeta(raw, 'a-app-secret-0001');
    for (const tenant of ['00000000-0000-4000-8000-0000000000ee', 'not-a-uuid']) {
      expect((await request(t.app).post(`/webhooks/meta/${tenant}`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw)).status, tenant).toBe(404);
    }
    const E = await addTenant('shop-e', 'Shop E');
    expect((await request(t.app).post(`/webhooks/meta/${E}`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw)).status).toBe(503);
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await owner.query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [A]);
    try { expect((await metaPost(A, 'a-app-secret-0001', 'while-suspended')).status).toBe(404); }
    finally { await owner.query("UPDATE tenants SET status = 'ACTIVE' WHERE id = $1", [A]); await owner.end(); }
  });
});

describe('removing credentials', () => {
  it('deleting a kind stops that channel for that business only', async () => {
    expect((await request(t.app).delete('/api/channel-config/whatsapp').set(h(adminA))).status).toBe(204);
    fetchCalls.length = 0;
    await inTenant(A, () => t.c.hub.send('whatsapp', '15550001', 'after delete'));
    expect(fetchCalls).toHaveLength(0);
    await inTenant(B, () => t.c.hub.send('whatsapp', '15550002', 'b still works'));
    expect(fetchCalls.some((c) => JSON.stringify(c.body).includes('b still works'))).toBe(true);
    expect((await request(t.app).get('/api/channel-config').set(h(adminA))).body.kinds.find((k: { kind: string }) => k.kind === 'whatsapp').configured).toBe(false);
  });
});
