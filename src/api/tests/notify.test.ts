import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { fakeFetch } from './helpers/fakeFetch.js';

let t: TestApp;
let staff: string;
let ids: Awaited<ReturnType<typeof seedCatalog>>;
const f = fakeFetch();
beforeAll(async () => {
  t = await buildTestApp({ TELEGRAM_BOT_TOKEN: '1:T', WHATSAPP_TOKEN: 'W', WHATSAPP_PHONE_NUMBER_ID: '99' }, { fetch: f.fn });
  staff = await t.token('staff');
  ids = await seedCatalog(t, staff);
  await t.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 10 }, null);
  await t.c.settings.update({ defaultWarehouseId: ids.main.id });
});
afterAll(async () => { await t.close(); });
const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const bodies = () => f.calls.map((c) => c.body as Record<string, unknown>);

describe('order status notifications', () => {
  it('notifies the chat customer on confirm, fulfil and cancel — but not on creation', async () => {
    await t.c.inbox.receive({ channel: 'telegram', from: '555', text: 'order TEE 1', externalId: 'tg:555:1' });
    f.calls.length = 0; // drop the bot reply
    const [order] = await t.c.orders.list({ status: 'PENDING' });
    await request(t.app).post(`/api/orders/${order!.id}/confirm`).set(auth(staff)).expect(200);
    await request(t.app).post(`/api/orders/${order!.id}/fulfill`).set(auth(staff)).expect(200);
    expect(bodies().map((b) => [b.chat_id, String(b.text).split(' ').slice(0, 1)[0]])).toEqual([['555', '✅'], ['555', '📦']]);
    expect(String(bodies()[0]!.text)).toContain(`#${order!.number}`);

    await t.c.inbox.receive({ channel: 'telegram', from: '555', text: 'order TEE 1', externalId: 'tg:555:2' });
    f.calls.length = 0;
    const [second] = await t.c.orders.list({ status: 'PENDING' });
    await request(t.app).post(`/api/orders/${second!.id}/cancel`).set(auth(staff)).expect(200);
    expect(String(bodies()[0]!.text)).toMatch(/^❌/);
  });

  it('does not message manual-channel customers', async () => {
    const cust = (await request(t.app).post('/api/customers').set(auth(staff)).send({ name: 'Walk-in' })).body;
    const o = await t.c.orders.create({ customerId: cust.id, channel: 'manual', items: [{ productId: ids.tee.id, quantity: 1 }] });
    f.calls.length = 0;
    await t.c.orders.confirm(o.id, undefined, null);
    expect(f.calls).toHaveLength(0);
  });
});

describe('messages & channels API', () => {
  it('lists channel status', async () => {
    const res = await request(t.app).get('/api/channels').set(auth(await t.token('viewer')));
    expect(res.body).toEqual([
      { name: 'whatsapp', configured: true }, { name: 'messenger', configured: false },
      { name: 'instagram', configured: false }, { name: 'telegram', configured: true },
    ]);
  });

  it('staff can send a manual reply which is logged in the inbox', async () => {
    f.calls.length = 0;
    const res = await request(t.app).post('/api/messages/send').set(auth(staff)).send({ channel: 'whatsapp', to: '+15550001', text: 'Hello from the shop' });
    expect(res.status).toBe(202);
    expect(f.calls[0]!.url).toContain('/99/messages');
    const inbox = await request(t.app).get('/api/messages?channel=whatsapp').set(auth(staff));
    expect(inbox.body[0]).toMatchObject({ direction: 'out', text: 'Hello from the shop', status: 'sent' });
    expect((await request(t.app).post('/api/messages/send').set(auth(await t.token('viewer'))).send({ channel: 'whatsapp', to: '1', text: 'x' })).status).toBe(403);
    expect((await request(t.app).post('/api/messages/send').set(auth(staff)).send({ channel: 'sms', to: '1', text: 'x' })).status).toBe(400);
  });
});
