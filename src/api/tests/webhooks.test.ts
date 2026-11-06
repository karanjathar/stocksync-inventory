import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { createContainer, type ContainerOverrides } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { loadEnv } from '../src/config/env.js';

/** Second app on the SAME test database (never reset the DB inside a test file). */
const appWith = (env: Record<string, string>, overrides: ContainerOverrides = {}) =>
  createApp(createContainer({ env: loadEnv({ ...TEST_ENV, ...env }), pool: t.pool, ...overrides }));
import { parseMetaWebhook, parseTelegramUpdate, telegramCallbackId } from '../src/channels/parse.js';
import { fakeFetch } from './helpers/fakeFetch.js';

let t: TestApp;
const sent: { channel: string; to: string; text: string }[] = [];
beforeAll(async () => {
  t = await buildTestApp({}, { messenger: { send: async (channel, to, text) => { sent.push({ channel, to, text }); } } });
});
afterAll(async () => { await t.close(); });

const sign = (raw: string, secret = 'meta-secret') => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

const waPayload = (id: string, text: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { phone_number_id: '1234' },
    contacts: [{ wa_id: '15551112222', profile: { name: 'Ravi' } }],
    messages: [{ id, from: '15551112222', timestamp: '1700000000', type: 'text', text: { body: text } }],
  } }] }],
});

describe('payload parsing', () => {
  it('parses WhatsApp text messages and skips statuses / non-text', () => {
    expect(parseMetaWebhook(waPayload('wamid.1', 'help'))).toEqual([
      { channel: 'whatsapp', from: '15551112222', text: 'help', externalId: 'wamid.1', senderName: 'Ravi' },
    ]);
    expect(parseMetaWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'x' }] } }] }] })).toEqual([]);
    expect(parseMetaWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: 'i', from: '1', type: 'image' }] } }] }] })).toEqual([]);
  });

  it('parses Messenger and Instagram, skipping echoes', () => {
    const page = { object: 'page', entry: [{ messaging: [
      { sender: { id: 'PSID1' }, message: { mid: 'm1', text: 'stock TEE' } },
      { sender: { id: 'PAGE' }, message: { mid: 'm2', text: 'echo', is_echo: true } },
      { sender: { id: 'PSID1' }, delivery: {} },
    ] }] };
    expect(parseMetaWebhook(page)).toEqual([{ channel: 'messenger', from: 'PSID1', text: 'stock TEE', externalId: 'm1' }]);
    const ig = { ...page, object: 'instagram' };
    expect(parseMetaWebhook(ig)[0]!.channel).toBe('instagram');
  });

  it('parses Telegram updates and tolerates garbage', () => {
    expect(parseTelegramUpdate({ update_id: 1, message: { message_id: 7, chat: { id: 42 }, from: { first_name: 'Li' }, text: 'catalog' } }))
      .toEqual({ channel: 'telegram', from: '42', text: 'catalog', externalId: 'tg:42:7', senderName: 'Li' });
    expect(parseTelegramUpdate({ update_id: 2, edited_message: {} })).toBeUndefined();
    expect(parseMetaWebhook(null)).toEqual([]);
    expect(parseMetaWebhook({ object: 'page', entry: 'nope' })).toEqual([]);
  });
});

describe('GET /webhooks/meta (verification)', () => {
  it('echoes the challenge for the right verify token only', async () => {
    const ok = await request(t.app).get('/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await request(t.app).get('/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });
});

describe('POST /webhooks/meta', () => {
  it('rejects missing or invalid signatures', async () => {
    const raw = JSON.stringify(waPayload('wamid.x', 'help'));
    expect((await request(t.app).post('/webhooks/meta').set('content-type', 'application/json').send(raw)).status).toBe(401);
    expect((await request(t.app).post('/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(raw, 'other')).send(raw)).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('processes a signed WhatsApp message once and replies', async () => {
    const raw = JSON.stringify(waPayload('wamid.ok', 'help'));
    const send = () => request(t.app).post('/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(raw)).send(raw);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200); // Meta retry
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'whatsapp', to: '15551112222' });
    expect(sent[0]!.text).toContain('catalog');
  });
});

describe('POST /webhooks/telegram', () => {
  const update = { update_id: 9, message: { message_id: 1, chat: { id: 77 }, text: 'help' } };
  it('requires the secret token header', async () => {
    expect((await request(t.app).post('/webhooks/telegram').send(update)).status).toBe(401);
    expect((await request(t.app).post('/webhooks/telegram').set('x-telegram-bot-api-secret-token', 'nope').send(update)).status).toBe(401);
  });
  it('processes valid updates', async () => {
    sent.length = 0;
    const res = await request(t.app).post('/webhooks/telegram').set('x-telegram-bot-api-secret-token', 'tg-secret').send(update);
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ channel: 'telegram', to: '77' });
  });
});

describe('unconfigured secrets', () => {
  it('refuses webhooks when secrets are not set', async () => {
    const u = appWith({ META_APP_SECRET: '', TELEGRAM_WEBHOOK_SECRET: '', META_VERIFY_TOKEN: '' });
    const raw = '{}';
    expect((await request(u).post('/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(raw, '')).send(raw)).status).toBe(503);
    expect((await request(u).post('/webhooks/telegram').set('x-telegram-bot-api-secret-token', '').send({})).status).toBe(503);
    expect((await request(u).get('/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' })).status).toBe(503);
  });
});

describe('interactive taps (T27)', () => {
  const waMsg = (m: object) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: '1555', profile: { name: 'Ravi' } }], messages: [{ id: 'wamid.T', from: '1555', ...m }] } }] }] });

  it('WhatsApp button_reply, list_reply and template button carry an action', () => {
    expect(parseMetaWebhook(waMsg({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'catalog', title: '🛍 Browse' } } })))
      .toEqual([{ channel: 'whatsapp', from: '1555', text: '🛍 Browse', action: 'catalog', externalId: 'wamid.T', senderName: 'Ravi' }]);
    expect(parseMetaWebhook(waMsg({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'prod:abc', title: 'Red Tee', description: '₹499' } } }))[0])
      .toMatchObject({ text: 'Red Tee', action: 'prod:abc' });
    expect(parseMetaWebhook(waMsg({ type: 'button', button: { payload: 'menu', text: 'Menu' } }))[0]).toMatchObject({ text: 'Menu', action: 'menu' });
    expect(parseMetaWebhook(waMsg({ type: 'interactive', interactive: { type: 'nfm_reply' } }))).toEqual([]);
  });

  it('Messenger/Instagram quick replies and postbacks carry an action', () => {
    const page = { object: 'page', entry: [{ messaging: [
      { sender: { id: 'PSID' }, message: { mid: 'm1', text: 'Browse', quick_reply: { payload: 'catalog' } } },
      { sender: { id: 'PSID' }, timestamp: 1700000000000, postback: { mid: 'm2', title: 'Get Started', payload: 'menu' } },
    ] }] };
    expect(parseMetaWebhook(page)).toEqual([
      { channel: 'messenger', from: 'PSID', text: 'Browse', action: 'catalog', externalId: 'm1' },
      { channel: 'messenger', from: 'PSID', text: 'Get Started', action: 'menu', externalId: 'm2' },
    ]);
    expect(parseMetaWebhook({ ...page, object: 'instagram' })[0]).toMatchObject({ channel: 'instagram', action: 'catalog' });
  });

  it('Telegram callback_query becomes an action and exposes its id for answering', () => {
    const update = { update_id: 5, callback_query: { id: 'cbq9', data: 'qty:abc:2', from: { first_name: 'Li' }, message: { message_id: 3, chat: { id: 77 } } } };
    expect(parseTelegramUpdate(update)).toEqual({ channel: 'telegram', from: '77', text: 'qty:abc:2', action: 'qty:abc:2', externalId: 'tgcb:cbq9', senderName: 'Li' });
    expect(telegramCallbackId(update)).toBe('cbq9');
    expect(telegramCallbackId({ update_id: 6, message: { message_id: 1, chat: { id: 1 }, text: 'hi' } })).toBeUndefined();
  });

  it('plain text messages still have no action (unchanged v1 behaviour)', () => {
    expect(parseMetaWebhook(waPayload('wamid.Z', 'stock TEE'))[0]).not.toHaveProperty('action');
  });
});

describe('Telegram webhook answers callback queries (T27)', () => {
  it('acknowledges the tap so the client spinner stops, then processes it once', async () => {
    const f = fakeFetch();
    const seen: string[] = [];
    const tg = appWith({ TELEGRAM_BOT_TOKEN: '1:T' }, { fetch: f.fn, messenger: { send: async (_c, _t, text) => { seen.push(text); } } });
    const update = { update_id: 7, callback_query: { id: 'cbq-x', data: 'help', from: { first_name: 'Li' }, message: { message_id: 3, chat: { id: 77 } } } };
    const post = () => request(tg).post('/webhooks/telegram').set('x-telegram-bot-api-secret-token', 'tg-secret').send(update);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(f.calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).map((c) => c.body)).toEqual([{ callback_query_id: 'cbq-x' }, { callback_query_id: 'cbq-x' }]);
    expect(seen).toHaveLength(1);
  });
});
