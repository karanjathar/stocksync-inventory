import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { fakeFetch } from './helpers/fakeFetch.js';

/** Release 3 security regression suite (docs/7_SECURITY_AUDIT.md §7.R3). */
let t: TestApp;
const f = fakeFetch(200, { messages: [{ id: 'wamid.S' }] });
beforeAll(async () => {
  t = await buildTestApp({ WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '99', TELEGRAM_BOT_TOKEN: 'tg' }, { fetch: f.fn });
});
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pool.query('TRUNCATE jobs, channel_messages'); f.calls.length = 0; });

const sign = (raw: string) => `sha256=${createHmac('sha256', 'meta-secret').update(raw).digest('hex')}`;
const statusHook = (id: string, status: string) => {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id, status }] } }] }] });
  return request(t.app).post('/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(raw)).send(raw);
};

describe('R3-01 template parameters from user-controlled text', () => {
  it('newlines, tabs and long runs of spaces never reach a template parameter (Meta rejects them with error 132018)', async () => {
    await t.c.settings.update({ whatsappTemplates: { order_confirmed: { name: 'order_confirmed_v1', language: 'en', params: ['customerName', 'orderNumber'] } } });
    await t.c.hub.send('whatsapp', '15551112222', 'Order confirmed', { event: 'order_confirmed', params: { customerName: 'Ravi\nKumar\t\r\nX      Y', orderNumber: '7' } });
    const body = f.calls[0]!.body as { template: { components: { parameters: { text: string }[] }[] } };
    const texts = body.template.components[0]!.parameters.map((p) => p.text);
    expect(texts).toEqual(['Ravi Kumar X Y', '7']);
    for (const text of texts) expect(text).not.toMatch(/[\n\r\t]|\s{4,}/);
  });

  it('an empty or whitespace-only value is replaced by a dash and very long values are cut', async () => {
    await t.c.settings.update({ whatsappTemplates: { order_confirmed: { name: 'order_confirmed_v1', language: 'en', params: ['customerName', 'productName'] } } });
    await t.c.hub.send('whatsapp', '15551112222', 'x', { event: 'order_confirmed', params: { customerName: ' \n ', productName: 'P'.repeat(5000) } });
    const body = f.calls[0]!.body as { template: { components: { parameters: { text: string }[] }[] } };
    const [a, b] = body.template.components[0]!.parameters.map((p) => p.text);
    expect(a).toBe('-');
    expect(b!.length).toBeLessThanOrEqual(1024);
  });
});

describe('R3-02 delivery receipts cannot touch other channels or other ids', () => {
  it('a WhatsApp receipt never updates a Telegram message that happens to share the provider id', async () => {
    await t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status, provider_message_id) VALUES ('telegram','out','42','hi','sent','777')");
    expect((await statusHook('777', 'read')).status).toBe(200);
    expect((await t.pool.query("SELECT status FROM channel_messages WHERE channel = 'telegram'")).rows[0].status).toBe('sent');
  });

  it('an unsigned or forged receipt changes nothing', async () => {
    await t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status, provider_message_id) VALUES ('whatsapp','out','1','hi','sent','wamid.X')");
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'read' }] } }] }] });
    expect((await request(t.app).post('/webhooks/meta').set('content-type', 'application/json').send(raw)).status).toBe(401);
    expect((await t.pool.query('SELECT status FROM channel_messages')).rows[0].status).toBe('sent');
  });
});

describe('R3-03 retries are bounded (no amplification)', () => {
  it('a message that always fails is sent at most 7 times in total and then stays failed', async () => {
    const failing = fakeFetch(503, { error: { message: 'down' } });
    const t2 = await buildTestApp({ WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '99' }, { fetch: failing.fn });
    try {
      await t2.c.hub.send('whatsapp', '1555', 'hi');
      for (let i = 0; i < 20; i++) { await t2.pool.query("UPDATE jobs SET run_at = now() WHERE status = 'pending'"); await t2.c.jobs.runOnce(); }
      expect(failing.calls.length).toBe(7);
      expect((await t2.pool.query("SELECT status FROM channel_messages WHERE direction = 'out'")).rows[0].status).toBe('failed');
      expect((await t2.pool.query("SELECT count(*)::int AS n FROM jobs WHERE status IN ('pending','running')")).rows[0].n).toBe(0);
    } finally { await t2.close(); }
  });

  it('hammering Retry on one failed message queues one job and one send', async () => {
    const staff = await t.token('staff');
    const id = (await t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status, payload) VALUES ('whatsapp','out','1555','hi','failed','{\"kind\":\"text\",\"text\":\"hi\"}') RETURNING id")).rows[0].id as string;
    const codes = await Promise.all(Array.from({ length: 15 }, () => request(t.app).post(`/api/messages/${id}/retry`).set({ authorization: `Bearer ${staff}` }).then((r) => r.status)));
    expect(codes.filter((c) => c === 202)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(14);
    await t.pool.query("UPDATE jobs SET run_at = now()");
    await t.c.jobs.runOnce(5);
    expect(f.calls).toHaveLength(1);
  });
});
