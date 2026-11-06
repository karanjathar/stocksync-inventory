import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { fakeFetch } from './helpers/fakeFetch.js';
import { createContainer } from '../src/container.js';
import { loadEnv } from '../src/config/env.js';
import { seedCatalog } from './helpers/fixtures.js';
import type { InboundMessage, RealtimeEvent } from '../src/domain/types.js';

let t: TestApp;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
const sent: { channel: string; to: string; text: string }[] = [];
const events: RealtimeEvent[] = [];

beforeAll(async () => {
  t = await buildTestApp({}, { messenger: { send: async (channel, to, text) => { sent.push({ channel, to, text }); } } });
  ids = await seedCatalog(t, await t.token('staff'));
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 9 }, null);
  await t.c.settings.update({ currency: 'INR', businessName: 'Corner Shop' });
  t.c.events.subscribe((e) => events.push(e));
});
afterAll(async () => { await t.close(); });

const wa = (text: string, from = '15551230000'): InboundMessage => ({ channel: 'whatsapp', from, text, senderName: 'Asha' });
const text = async (m: InboundMessage) => (await t.c.bot.handle(m)).text;

describe('bot commands', () => {
  it('help and unknown input show the command list', async () => {
    for (const input of ['help', 'HI', 'what?']) {
      const reply = await text(wa(input));
      expect(reply).toContain('Corner Shop');
      expect(reply).toContain('stock <SKU>');
    }
  });

  it('stock and price lookups (case-insensitive SKU)', async () => {
    expect(await text(wa('stock tee'))).toMatch(/T-Shirt \(TEE\): 9 pcs available/);
    expect(await text(wa('Price TEE'))).toContain('₹15.00');
    expect(await text(wa('stock NOPE'))).toMatch(/couldn't find.*NOPE/i);
  });

  it('catalog lists in-stock active products only', async () => {
    const reply = await text(wa('catalog'));
    expect(reply).toContain('TEE');
    expect(reply).not.toContain('MUG'); // zero stock
  });

  it('order creates a PENDING order for the chat customer', async () => {
    const reply = await text(wa('order tee 2'));
    expect(reply).toMatch(/Order #\d+ received/);
    expect(reply).toContain('₹30.00');
    const [order] = await t.c.orders.list({ status: 'PENDING' });
    expect(order).toMatchObject({ channel: 'whatsapp', customerName: 'Asha', totalCents: 3000 });
    expect(await text(wa('order tee 50'))).toMatch(/only have 9 pcs/i);
    expect(await text(wa('order tee 0'))).toContain('order <SKU> <qty>');
  });

  it('combines a multi-line cart message (from the shop WhatsApp button) into one order', async () => {
    await t.c.stock.receive({ productId: ids.mug.id, warehouseId: ids.main.id, quantity: 5 }, null);
    const reply = await text(wa("Hi Corner Shop! I'd like to order:\norder TEE 1\norder MUG 2", '15557770000'));
    expect(reply).toMatch(/Order #\d+ received: 1 × T-Shirt, 2 × Mug = ₹31\.00/);
    const orders = await t.c.orders.list({});
    expect(orders[0]!.items.map((i) => [i.sku, i.quantity])).toEqual([['MUG', 2], ['TEE', 1]]);
    expect(await text(wa('order TEE 1\norder NOPE 1'))).toMatch(/couldn't find.*NOPE/i);
  });

  it('status only reveals the customer’s own orders', async () => {
    const order = (await t.c.orders.list({ status: 'PENDING' })).at(-1); // oldest: placed by 15551230000
    expect(await text(wa(`status ${order!.number}`))).toContain('PENDING');
    expect(await text(wa(`status ${order!.number}`, '19990000000'))).toMatch(/couldn't find order/i);
  });
});

describe('rich replies (T28)', () => {
  it('help/unknown input shows the welcome text with the tap-to-order menu', async () => {
    const reply = await t.c.bot.handle(wa('hello there'));
    expect(reply.text).toContain('stock <SKU>');
    expect(reply.buttons).toEqual([{ id: 'catalog', title: '🛍 Browse' }, { id: 'cart', title: '🛒 My cart' }, { id: 'orders', title: '📦 My orders' }]); // FR-R2-7 menu since T33
  });

  it('a tapped action is routed like the matching command', async () => {
    // Since T31 the catalog/menu actions are owned by the tap-to-order ChatFlow (docs/3_SCHEMAS.md §3.12).
    const reply = await t.c.bot.handle({ ...wa('🛍 Browse catalog'), action: 'catalog' });
    expect(reply.text).toContain('pick a product');
    expect(reply.list?.sections[0]!.rows.map((r) => r.title)).toContain('T-Shirt');
    expect((await t.c.bot.handle({ ...wa('whatever'), action: 'menu' })).buttons?.map((b) => b.id)).toEqual(['catalog', 'cart', 'orders']);
  });
});

describe('inbound pipeline', () => {
  it('logs, publishes, replies once and ignores retries', async () => {
    sent.length = 0;
    const msg: InboundMessage = { ...wa('stock tee'), externalId: 'wamid.ABC' };
    await t.c.inbox.receive(msg);
    await t.c.inbox.receive(msg);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'whatsapp', to: '15551230000' });
    expect(events.filter((e) => e.type === 'message.received')).toHaveLength(1);
    const log = await t.c.messages.list({ channel: 'whatsapp' });
    expect(log.filter((m) => m.direction === 'in')).toHaveLength(1);
  });
});

describe('numbered replies via the real channel hub (T28)', () => {
  it('logs the options shown and maps "1" back to the tapped action', async () => {
    const f = fakeFetch();
    const c = createContainer({ env: loadEnv({ ...TEST_ENV, TELEGRAM_BOT_TOKEN: '1:T' }), pool: t.pool, fetch: f.fn });
    await c.inbox.receive({ channel: 'telegram', from: '501', text: 'hi', externalId: 'tg:501:1' });
    const first = f.calls.at(-1)!.body as { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
    expect(first.reply_markup.inline_keyboard[0]![0]!.callback_data).toBe('catalog');
    const log = (await c.messages.list({ channel: 'telegram', limit: 1 }))[0]!;
    expect(log.text).toContain('1. 🛍 Browse\n2. 🛒 My cart\n3. 📦 My orders');
    expect(await c.messages.lastOptions('telegram', '501')).toEqual([{ id: 'catalog', title: '🛍 Browse' }, { id: 'cart', title: '🛒 My cart' }, { id: 'orders', title: '📦 My orders' }]);

    await c.inbox.receive({ channel: 'telegram', from: '501', text: '1', externalId: 'tg:501:2' });
    expect(String((f.calls.at(-1)!.body as { text: string }).text)).toContain('pick a product'); // "1" → catalog action → interactive catalog
    await c.inbox.receive({ channel: 'telegram', from: '501', text: '7', externalId: 'tg:501:3' }); // no 7th option → welcome
    expect(String((f.calls.at(-1)!.body as { text: string }).text)).toContain('Welcome');
  });
});

describe('tap labels in the inbox (T45)', () => {
  it('logs and publishes the option title for label-less Telegram taps', async () => {
    const events: RealtimeEvent[] = [];
    const c = createContainer({ env: loadEnv({ ...TEST_ENV, TELEGRAM_BOT_TOKEN: '1:T' }), pool: t.pool, fetch: fakeFetch().fn });
    c.events.subscribe((e) => events.push(e));
    await c.inbox.receive({ channel: 'telegram', from: '777', text: 'hey', externalId: 'tg:777:1' });
    await c.inbox.receive({ channel: 'telegram', from: '777', text: 'catalog', action: 'catalog', externalId: 'tgcb:abc' });
    const inbound = (await c.messages.list({ channel: 'telegram', limit: 10 })).filter((m) => m.direction === 'in' && m.externalUser === '777');
    expect(inbound.map((m) => m.text)).toEqual(['🛍 Browse', 'hey']);
    expect(events.filter((e) => e.type === 'message.received').map((e) => e.type === 'message.received' && e.text)).toEqual(['hey', '🛍 Browse']);
    // unknown action ids fall back to the raw id
    await c.inbox.receive({ channel: 'telegram', from: '777', text: 'zzz', action: 'zzz', externalId: 'tgcb:def' });
    expect((await c.messages.list({ channel: 'telegram', limit: 10 })).find((m) => m.direction === 'in' && m.text === 'zzz')).toBeTruthy();
  });
});
