import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { freshDb } from './helpers/db.js';
import { ChannelHub } from '../src/channels/hub.js';
import { WhatsAppAdapter } from '../src/channels/whatsapp.js';
import { TelegramAdapter } from '../src/channels/telegram.js';
import { MessagesRepo } from '../src/repositories/messages.js';
import { SettingsService } from '../src/services/settings.js';
import { OrderNotifier } from '../src/services/orderNotifier.js';
import { CustomersRepo } from '../src/repositories/customers.js';
import type { Order } from '../src/domain/types.js';

let pool: pg.Pool;
let settings: SettingsService;
beforeAll(async () => { pool = await freshDb(); settings = new SettingsService(pool); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE jobs, channel_messages');
  await pool.query("DELETE FROM settings WHERE key = 'whatsappTemplates'");
});

type Reply = { status: number; body: unknown };
const OK: Reply = { status: 200, body: { messages: [{ id: 'wamid.T' }] } };
const REENGAGE: Reply = { status: 400, body: { error: { message: 'Re-engagement message', code: 131047 } } };
function setup(replies: Reply[] = [OK]) {
  const calls: { body: Record<string, unknown> }[] = [];
  const fn = (async (_u: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const repo = new MessagesRepo(pool);
  const hub = new ChannelHub([
    new WhatsAppAdapter({ token: 't', phoneNumberId: '99', graphVersion: 'v21.0' }, fn),
    new TelegramAdapter({ token: 't' }, fn),
  ], repo, () => settings.get());
  return { calls, hub };
}
const mapOrderConfirmed = () => settings.update({ whatsappTemplates: { order_confirmed: { name: 'order_confirmed_v1', language: 'en', params: ['orderNumber', 'total'] } } });
const inbound = (ageHours: number) => pool.query(
  "INSERT INTO channel_messages (channel, direction, external_user, text, created_at) VALUES ('whatsapp','in','15551112222','hi', now() - make_interval(hours => $1))", [ageHours]);
const out = async () => (await pool.query("SELECT status, error_code, error_message, payload FROM channel_messages WHERE direction = 'out'")).rows[0];
const notify = { event: 'order_confirmed', params: { orderNumber: '12', total: '₹500.00' } } as const;

describe('24-hour window and templates', () => {
  it('inside the window a notification is sent as normal free-form text', async () => {
    const { calls, hub } = setup(); await mapOrderConfirmed(); await inbound(2);
    await hub.send('whatsapp', '+1 555 111 2222', 'Order confirmed', notify);
    expect(calls[0]!.body).toMatchObject({ type: 'text' });
  });

  it('outside the window the mapped template is sent with ordered parameters', async () => {
    const { calls, hub } = setup(); await mapOrderConfirmed(); await inbound(30);
    await hub.send('whatsapp', '15551112222', 'Order confirmed', notify);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ type: 'template', template: { name: 'order_confirmed_v1', language: { code: 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: '12' }, { type: 'text', text: '₹500.00' }] }] } });
    expect(await out()).toMatchObject({ status: 'sent' });
  });

  it('with no inbound message at all the window is closed', async () => {
    const { calls, hub } = setup(); await mapOrderConfirmed();
    await hub.send('whatsapp', '15551112222', 'Order confirmed', notify);
    expect(calls[0]!.body).toMatchObject({ type: 'template' });
  });

  it('outside the window without a mapping fails visibly and sends nothing', async () => {
    const { calls, hub } = setup(); await inbound(48);
    await hub.send('whatsapp', '15551112222', 'Order confirmed', notify);
    expect(calls).toHaveLength(0);
    expect(await out()).toMatchObject({ status: 'failed', error_code: 'NO_TEMPLATE', error_message: expect.stringContaining('no template configured') });
    expect((await pool.query('SELECT 1 FROM jobs')).rowCount).toBe(0);
  });

  it('falls back to the template once when Meta answers 131047 inside what we thought was the window', async () => {
    const { calls, hub } = setup([REENGAGE, OK]); await mapOrderConfirmed(); await inbound(1);
    await hub.send('whatsapp', '15551112222', 'Order confirmed', notify);
    expect(calls.map((c) => c.body.type)).toEqual(['text', 'template']);
    expect(await out()).toMatchObject({ status: 'sent', payload: { kind: 'template' } });
  });

  it('131047 without a mapping fails with Meta\'s code, not silently', async () => {
    const { calls, hub } = setup([REENGAGE]); await inbound(1);
    await expect(hub.send('whatsapp', '15551112222', 'x', notify)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(await out()).toMatchObject({ status: 'failed', error_code: '131047' });
  });

  it('bot replies and other channels never use templates', async () => {
    const { calls, hub } = setup(); await mapOrderConfirmed();
    await hub.send('whatsapp', '15551112222', 'plain bot answer'); // no event, window closed
    await hub.send('telegram', '42', 'Order confirmed', notify);
    expect(calls.map((c) => c.body.type ?? 'telegram')).toEqual(['text', 'telegram']);
  });
});

describe('notifications carry their event', () => {
  it('OrderNotifier tags confirmation, payment, fulfilment and cancellation', async () => {
    const seen: { event?: string; params?: Record<string, string> }[] = [];
    const messenger = { send: async (_c: string, _t: string, _x: string, o?: { event?: string; params?: Record<string, string> }) => { seen.push({ ...o }); } };
    const customers = { get: async () => ({ id: 'c1', channelUserId: '15551112222' }) } as unknown as CustomersRepo;
    const n = new OrderNotifier(customers, settings, messenger as never);
    const order = (status: string, paymentStatus: string) => ({ id: 'o', number: 12, status, paymentStatus, channel: 'whatsapp', customerId: 'c1', totalCents: 50000 }) as unknown as Order;
    await n.onStatusChange(order('CONFIRMED', 'UNPAID'), 'PENDING');
    await n.onStatusChange(order('CONFIRMED', 'PAID'), 'PENDING');
    await n.onStatusChange(order('FULFILLED', 'UNPAID'), 'CONFIRMED');
    await n.onStatusChange(order('CANCELLED', 'UNPAID'), 'PENDING');
    expect(seen.map((s) => s.event)).toEqual(['order_confirmed', 'payment_received', 'order_fulfilled', 'order_cancelled']);
    expect(seen[0]!.params).toMatchObject({ orderNumber: '12', businessName: 'StockSync' });
    expect(seen[0]!.params!.total).toContain('500');
  });
});
