import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { parseWhatsAppStatuses } from '../src/channels/parse.js';
import type { RealtimeEvent } from '../src/domain/types.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pool.query('TRUNCATE channel_messages'); });

const sign = (raw: string, secret = 'meta-secret') => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const statusBody = (id: string, status: string, errors?: { code: number; title: string }[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: '1234' },
    statuses: [{ id, status, timestamp: '1700000000', recipient_id: '15551112222', ...(errors ? { errors } : {}) }],
  } }] }],
});
const post = (body: unknown, secret = 'meta-secret') => {
  const raw = JSON.stringify(body);
  return request(t.app).post('/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(raw, secret)).send(raw);
};
const seed = async (wamid = 'wamid.OUT', status = 'sent') => {
  await t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status, provider_message_id) VALUES ('whatsapp','out','15551112222','hi',$1,$2)", [status, wamid]);
};
const row = async () => (await t.pool.query('SELECT status, error_code, error_message FROM channel_messages WHERE direction = $1', ['out'])).rows[0];

describe('parseWhatsAppStatuses', () => {
  it('extracts statuses with error details and ignores other statuses', () => {
    expect(parseWhatsAppStatuses(statusBody('w1', 'failed', [{ code: 131047, title: 'Re-engagement message' }]))).toEqual([
      { id: 'w1', status: 'failed', errorCode: '131047', errorTitle: 'Re-engagement message' }]);
    expect(parseWhatsAppStatuses(statusBody('w1', 'delivered'))).toEqual([{ id: 'w1', status: 'delivered' }]);
    expect(parseWhatsAppStatuses(statusBody('w1', 'deleted'))).toEqual([]);
    expect(parseWhatsAppStatuses({ object: 'page', entry: [] })).toEqual([]);
  });
});

describe('WhatsApp delivery status webhooks', () => {
  it('moves forward sent → delivered → read and never regresses on replays or out-of-order receipts', async () => {
    await seed();
    expect((await post(statusBody('wamid.OUT', 'delivered'))).status).toBe(200);
    expect((await row()).status).toBe('delivered');
    await post(statusBody('wamid.OUT', 'sent')); // late "sent" must not regress
    expect((await row()).status).toBe('delivered');
    await post(statusBody('wamid.OUT', 'read'));
    await post(statusBody('wamid.OUT', 'delivered')); // replay
    expect((await row()).status).toBe('read');
  });

  it('records failure with the provider code and title, and failed is terminal', async () => {
    await seed();
    await post(statusBody('wamid.OUT', 'failed', [{ code: 131047, title: 'Re-engagement message' }]));
    expect(await row()).toMatchObject({ status: 'failed', error_code: '131047', error_message: 'Re-engagement message' });
    await post(statusBody('wamid.OUT', 'delivered'));
    expect((await row()).status).toBe('failed');
  });

  it('ignores unknown message ids and inbound rows', async () => {
    await seed();
    await t.pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, external_id, provider_message_id) VALUES ('whatsapp','in','1','x','wamid.IN','wamid.IN')");
    expect((await post(statusBody('wamid.NOPE', 'read'))).status).toBe(200);
    await post(statusBody('wamid.IN', 'read'));
    expect((await row()).status).toBe('sent');
    expect((await t.pool.query("SELECT status FROM channel_messages WHERE direction = 'in'")).rows[0].status).toBe('ok');
  });

  it('rejects forged status webhooks without changing state', async () => {
    await seed();
    expect((await post(statusBody('wamid.OUT', 'read'), 'wrong-secret')).status).toBe(401);
    expect((await row()).status).toBe('sent');
  });

  it('publishes message.status for live Inbox updates', async () => {
    await seed();
    const seen: RealtimeEvent[] = [];
    const off = t.c.events.subscribe((e) => seen.push(e));
    await post(statusBody('wamid.OUT', 'delivered'));
    await post(statusBody('wamid.OUT', 'delivered')); // no change → no event
    off();
    expect(seen).toEqual([expect.objectContaining({ type: 'message.status', channel: 'whatsapp', status: 'delivered' })]);
  });
});
