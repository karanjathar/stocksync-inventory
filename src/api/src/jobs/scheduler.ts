import type pg from 'pg';
import { runWithTenant } from '../db/tenant.js';
import type { JobQueue } from './queue.js';

const TASKS = [
  { task: 'expireUnpaid', kind: 'maintenance.expireUnpaid', everyMs: 60 * 60_000 },
  { task: 'prune', kind: 'maintenance.prune', everyMs: 24 * 60 * 60_000 },
] as const;

/**
 * Enqueues each maintenance task that is due (never ran, or last ran longer ago than its interval).
 * Safe with several replicas: the dedupe key keeps one pending/running job per task, and ran_at is written by the job itself.
 * Returns the tasks enqueued by this call.
 */
export async function scheduleDue(pool: pg.Pool, queue: JobQueue, tenantIds?: string[]): Promise<string[]> {
  if (tenantIds) { // one pass per business, each inside its own tenant context (its own runs, its own jobs)
    const all: string[] = [];
    for (const id of tenantIds) all.push(...(await runWithTenant(id, () => scheduleDue(pool, queue))));
    return all;
  }
  const { rows } = await pool.query<{ task: string; age_ms: number }>('SELECT task, extract(epoch FROM now() - ran_at) * 1000 AS age_ms FROM maintenance_runs');
  const age = new Map(rows.map((r) => [r.task, Number(r.age_ms)]));
  const enqueued: string[] = [];
  for (const t of TASKS) {
    const last = age.get(t.task);
    if (last !== undefined && last < t.everyMs) continue;
    if (await queue.enqueue(t.kind, {}, { dedupeKey: t.task, maxAttempts: 3 }) !== null) enqueued.push(t.task);
  }
  return enqueued;
}

/** Checks every minute whether a task is due. */
export function startScheduler(pool: pg.Pool, queue: JobQueue, onError: (err: unknown) => void, tickMs = 60_000, tenantIds?: () => Promise<string[]>): () => void {
  const tick = () => { (async () => scheduleDue(pool, queue, tenantIds ? await tenantIds() : undefined))().catch(onError); };
  tick();
  const timer = setInterval(tick, tickMs);
  return () => clearInterval(timer);
}
