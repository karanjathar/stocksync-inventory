import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp({ WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '99' }, {
  fetch: (async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.R' }] }), { status: 200 })) as typeof fetch }); });
afterAll(async () => { await t.close(); });
const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const insert = async (status: string, dir = 'out') => (await t.pool.query(
  `INSERT INTO channel_messages (channel, direction, external_user, text, status, payload, error_code, error_message)
   VALUES ('whatsapp', $2, '15551112222', 'retry me', $1, '{"kind":"text","text":"retry me"}', '131047', 'Re-engagement message') RETURNING id`, [status, dir])).rows[0].id as string;

describe('POST /api/messages/:id/retry', () => {
  it('re-queues a failed outbound message, clears its error and the worker sends it', async () => {
    const staff = await t.token('staff');
    const id = await insert('failed');
    const res = await request(t.app).post(`/api/messages/${id}/retry`).set(auth(staff));
    expect(res.status).toBe(202);
    expect((await t.pool.query('SELECT status, error_code FROM channel_messages WHERE id = $1', [id])).rows[0]).toEqual({ status: 'queued', error_code: null });
    expect(await t.c.jobs.runOnce()).toBe(1);
    expect((await t.pool.query('SELECT status, provider_message_id FROM channel_messages WHERE id = $1', [id])).rows[0]).toEqual({ status: 'sent', provider_message_id: 'wamid.R' });
  });

  it('is safe to double-click: the second call conflicts and only one job exists', async () => {
    const staff = await t.token('staff');
    const id = await insert('failed');
    expect((await request(t.app).post(`/api/messages/${id}/retry`).set(auth(staff))).status).toBe(202);
    expect((await request(t.app).post(`/api/messages/${id}/retry`).set(auth(staff))).status).toBe(409);
    expect((await t.pool.query("SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = $1 AND status = 'pending'", [id])).rows[0].n).toBe(1);
  });

  it('only failed outbound messages can be retried; unknown ids are 404; viewers are refused', async () => {
    const staff = await t.token('staff');
    for (const [status, dir] of [['sent', 'out'], ['queued', 'out'], ['failed', 'in']] as const) {
      expect((await request(t.app).post(`/api/messages/${await insert(status, dir)}/retry`).set(auth(staff))).status, `${dir}/${status}`).toBe(409);
    }
    expect((await request(t.app).post('/api/messages/00000000-0000-4000-8000-000000000000/retry').set(auth(staff))).status).toBe(404);
    expect((await request(t.app).post('/api/messages/not-a-uuid/retry').set(auth(staff))).status).toBe(404);
    expect((await request(t.app).post(`/api/messages/${await insert('failed')}/retry`).set(auth(await t.token('viewer')))).status).toBe(403);
    expect((await request(t.app).post(`/api/messages/${await insert('failed')}/retry`)).status).toBe(401);
  });

  it('exposes the failure reason in the message list', async () => {
    const staff = await t.token('staff');
    await insert('failed');
    const list = await request(t.app).get('/api/messages?channel=whatsapp').set(auth(staff));
    expect(list.body.find((m: { status: string }) => m.status === 'failed')).toMatchObject({ errorCode: '131047', errorMessage: 'Re-engagement message' });
  });
});
