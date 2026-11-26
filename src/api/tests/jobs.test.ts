import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { freshDb } from './helpers/db.js';
import { JobQueue, PermanentJobError, backoffMs } from '../src/jobs/queue.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await pool.query('TRUNCATE jobs, worker_heartbeats'); });

const row = async (id: number) => (await pool.query('SELECT status, attempts, last_error, run_at > now() AS future FROM jobs WHERE id = $1', [id])).rows[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('backoffMs', () => {
  it('doubles from 30s, caps at 30 minutes, with ±20% jitter', () => {
    expect(backoffMs(1, () => 0.5)).toBe(60_000);
    expect(backoffMs(2, () => 0.5)).toBe(120_000);
    expect(backoffMs(20, () => 0.5)).toBe(30 * 60_000);
    expect(backoffMs(1, () => 0)).toBe(48_000);
    expect(backoffMs(1, () => 1)).toBe(72_000);
  });
});

describe('JobQueue', () => {
  it('runs a due job once with its payload and marks it done', async () => {
    const q = new JobQueue(pool, { workerId: 'w1' });
    const seen: unknown[] = [];
    q.register('demo', async (job) => { seen.push(job.payload); });
    const id = await q.enqueue('demo', { n: 1 });
    expect(await q.runOnce()).toBe(1);
    expect(seen).toEqual([{ n: 1 }]);
    expect((await row(id!))).toMatchObject({ status: 'done', attempts: 1 });
    expect(await q.runOnce()).toBe(0);
  });

  it('does not run a job before its run_at', async () => {
    const q = new JobQueue(pool, { workerId: 'w1' });
    q.register('demo', async () => {});
    await q.enqueue('demo', {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await q.runOnce()).toBe(0);
  });

  it('dedupes pending jobs by key but allows a new one after it finished', async () => {
    const q = new JobQueue(pool, { workerId: 'w1' });
    q.register('demo', async () => {});
    const a = await q.enqueue('demo', {}, { dedupeKey: 'k' });
    expect(a).not.toBeNull();
    expect(await q.enqueue('demo', {}, { dedupeKey: 'k' })).toBeNull();
    await q.runOnce();
    expect(await q.enqueue('demo', {}, { dedupeKey: 'k' })).not.toBeNull();
  });

  it('never runs one job twice with two competing workers', async () => {
    const counts = new Map<number, number>();
    const mk = (id: string) => {
      const q = new JobQueue(pool, { workerId: id });
      q.register('demo', async (job) => { counts.set(job.id, (counts.get(job.id) ?? 0) + 1); await sleep(5); });
      return q;
    };
    const a = mk('a'); const b = mk('b');
    for (let i = 0; i < 30; i++) await a.enqueue('demo', { i });
    const drain = async (q: JobQueue) => { while (await q.runOnce(3)) { /* keep draining */ } };
    await Promise.all([drain(a), drain(b), drain(a), drain(b)]);
    expect(counts.size).toBe(30);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });

  it('reschedules a failed job with backoff and records the error', async () => {
    const q = new JobQueue(pool, { workerId: 'w1' });
    q.register('flaky', async () => { throw new Error('provider 503'); });
    const id = await q.enqueue('flaky', {});
    await q.runOnce();
    expect(await row(id!)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'provider 503', future: true });
  });

  it('a PermanentJobError ends the job as dead immediately', async () => {
    const q = new JobQueue(pool, { workerId: 'w1' });
    q.register('bad', async () => { throw new PermanentJobError('400 bad request'); });
    const id = await q.enqueue('bad', {});
    await q.runOnce();
    expect(await row(id!)).toMatchObject({ status: 'dead', attempts: 1, last_error: '400 bad request' });
  });

  it('ends dead when attempts are exhausted', async () => {
    const q = new JobQueue(pool, { workerId: 'w1' });
    q.register('flaky', async () => { throw new Error('nope'); });
    const id = await q.enqueue('flaky', {}, { maxAttempts: 2 });
    await q.runOnce();
    await pool.query('UPDATE jobs SET run_at = now() WHERE id = $1', [id]);
    await q.runOnce();
    expect(await row(id!)).toMatchObject({ status: 'dead', attempts: 2 });
  });

  it('a job without a handler is dead, not retried forever', async () => {
    const q = new JobQueue(pool, { workerId: 'w1' });
    const id = await q.enqueue('mystery', {});
    await q.runOnce();
    expect(await row(id!)).toMatchObject({ status: 'dead' });
  });

  it('reclaims a job whose worker died (expired lock) and kills one that keeps crashing', async () => {
    const q = new JobQueue(pool, { workerId: 'w1' });
    const ran: number[] = [];
    q.register('demo', async (job) => { ran.push(job.id); });
    const { rows: [crashed] } = await pool.query<{ id: number }>("INSERT INTO jobs (kind, status, attempts, locked_until) VALUES ('demo','running',1, now() - interval '1 minute') RETURNING id");
    const { rows: [exhausted] } = await pool.query<{ id: number }>("INSERT INTO jobs (kind, status, attempts, max_attempts, locked_until) VALUES ('demo','running',6,6, now() - interval '1 minute') RETURNING id");
    const { rows: [live] } = await pool.query<{ id: number }>("INSERT INTO jobs (kind, status, attempts, locked_until) VALUES ('demo','running',1, now() + interval '1 minute') RETURNING id");
    await q.runOnce();
    expect(ran).toEqual([crashed!.id]);
    expect((await row(crashed!.id))).toMatchObject({ status: 'done', attempts: 2 });
    expect((await row(exhausted!.id))).toMatchObject({ status: 'dead' });
    expect((await row(live!.id))).toMatchObject({ status: 'running' });
  });

  it('start() polls, writes a heartbeat, and stop() drains in-flight jobs', async () => {
    const q = new JobQueue(pool, { workerId: 'w-poll' });
    let finished = false;
    q.register('slow', async () => { await sleep(150); finished = true; });
    const id = await q.enqueue('slow', {});
    q.start({ concurrency: 2, pollMs: 20 });
    await sleep(80); // job is in flight
    await q.stop();
    expect(finished).toBe(true);
    expect((await row(id!)).status).toBe('done');
    const hb = await pool.query("SELECT 1 FROM worker_heartbeats WHERE worker_id = 'w-poll' AND seen_at > now() - interval '1 minute'");
    expect(hb.rowCount).toBe(1);
    await q.enqueue('slow', {});
    await sleep(80);
    expect(await q.runOnce()).toBe(1); // nothing consumed while stopped
  });
});
