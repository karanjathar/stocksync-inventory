import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { freshDb } from './helpers/db.js';
import { ChannelHub } from '../src/channels/hub.js';
import { WhatsAppAdapter } from '../src/channels/whatsapp.js';
import { TelegramAdapter } from '../src/channels/telegram.js';
import { MessagesRepo } from '../src/repositories/messages.js';
import { JobQueue } from '../src/jobs/queue.js';
import { registerMessageSend } from '../src/jobs/messageSend.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await pool.query('TRUNCATE jobs, channel_messages'); });

/** fetch that answers with the given statuses in order (the last one repeats). */
function seqFetch(statuses: number[], wamid = 'wamid.A') {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    const body = status < 300 ? { messages: [{ id: wamid }] } : { error: { message: `provider said ${status}`, code: status } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

function setup(statuses: number[], configured = true) {
  const f = seqFetch(statuses);
  const repo = new MessagesRepo(pool);
  const hub = new ChannelHub([
    new WhatsAppAdapter(configured ? { token: 't', phoneNumberId: '99', graphVersion: 'v21.0' } : { graphVersion: 'v21.0' }, f.fn),
    new TelegramAdapter({}, f.fn),
  ], repo);
  const queue = new JobQueue(pool, { workerId: 'w' });
  registerMessageSend(queue, hub);
  return { f, repo, hub, queue };
}
const msg = async () => (await pool.query('SELECT status, attempts, provider_message_id, error_code, error_message, payload FROM channel_messages WHERE direction = $1', ['out'])).rows[0];
const makeDue = () => pool.query('UPDATE jobs SET run_at = now() WHERE status = $1', ['pending']);

describe('outbox', () => {
  it('stores then sends, recording the provider message id', async () => {
    const { f, hub } = setup([200]);
    await hub.send('whatsapp', '+91 99999', 'hello');
    expect(f.calls).toHaveLength(1);
    expect(await msg()).toMatchObject({ status: 'sent', provider_message_id: 'wamid.A' });
  });

  it('retries a 5xx with backoff until it succeeds (500, 500, 200 → sent after two retries)', async () => {
    const { f, hub, queue } = setup([500, 500, 200]);
    await expect(hub.send('whatsapp', '1555', 'hi')).resolves.toBeUndefined(); // durable: no error to the caller
    expect(await msg()).toMatchObject({ status: 'queued', attempts: 1, error_code: '500' });
    await makeDue(); await queue.runOnce();
    expect(await msg()).toMatchObject({ status: 'queued', attempts: 2 });
    await makeDue(); await queue.runOnce();
    expect(await msg()).toMatchObject({ status: 'sent', provider_message_id: 'wamid.A', error_code: null });
    expect(f.calls).toHaveLength(3);
  });

  it('a 4xx fails at once, tells the caller, and never retries', async () => {
    const { f, hub, queue } = setup([400]);
    await expect(hub.send('whatsapp', '1555', 'hi')).rejects.toThrow(/400/);
    expect(await msg()).toMatchObject({ status: 'failed', error_code: '400' });
    await makeDue(); await queue.runOnce();
    expect(f.calls).toHaveLength(1);
  });

  it('gives up visibly after the last attempt', async () => {
    const { f, hub, queue } = setup([503]);
    await hub.send('whatsapp', '1555', 'hi');
    for (let i = 0; i < 6; i++) { await makeDue(); await queue.runOnce(); }
    expect(await msg()).toMatchObject({ status: 'failed', error_code: '503' });
    expect(f.calls).toHaveLength(7); // 1 immediate + 6 job attempts
    expect((await pool.query("SELECT status FROM jobs")).rows[0]).toMatchObject({ status: 'dead' });
  });

  it('a message stored but never sent (crash) is sent exactly once by the worker', async () => {
    const { f, repo, queue } = setup([200]);
    await repo.createOutbound({ channel: 'whatsapp', to: '1555', text: 'orphan', payload: { kind: 'text', text: 'orphan' }, status: 'queued' });
    expect(f.calls).toHaveLength(0);
    await makeDue(); await queue.runOnce();
    await makeDue(); await queue.runOnce();
    expect(f.calls).toHaveLength(1);
    expect(await msg()).toMatchObject({ status: 'sent' });
  });

  it('keeps interactive replies interactive when retried', async () => {
    const { f, hub, queue } = setup([502, 200]);
    await hub.reply('whatsapp', '1555', { text: 'Pick one', buttons: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
    await makeDue(); await queue.runOnce();
    expect(f.calls[1]!.body).toMatchObject({ type: 'interactive' });
    expect(await msg()).toMatchObject({ status: 'sent' });
  });

  it('an unconfigured channel is skipped and queues nothing', async () => {
    const { f, hub } = setup([200], false);
    await hub.send('whatsapp', '1555', 'x');
    expect(f.calls).toHaveLength(0);
    expect(await msg()).toMatchObject({ status: 'skipped' });
    expect((await pool.query('SELECT 1 FROM jobs')).rowCount).toBe(0);
  });
});
