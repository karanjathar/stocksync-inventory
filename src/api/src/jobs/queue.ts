import type { Queryable } from '../db/pool.js';
import { currentTenantId, runWithTenant } from '../db/tenant.js';

export interface Job { id: number; kind: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number; tenantId: string | null }
export type JobHandler = (job: Job) => Promise<void>;
export interface EnqueueOptions { runAt?: Date; dedupeKey?: string; maxAttempts?: number }
export interface StartOptions { concurrency?: number; pollMs?: number }
export interface QueueOptions { workerId: string; onError?: (err: unknown, job?: Job) => void; lockSeconds?: number }

/** Throw from a handler to stop retrying: the job ends `dead` at once. */
export class PermanentJobError extends Error {}

const BASE_MS = 30_000;
const CAP_MS = 30 * 60_000;

/** min(2^attempts · 30 s, 30 min) ± 20 % jitter. `rand` is injectable for tests. */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  const base = Math.min(BASE_MS * 2 ** attempts, CAP_MS);
  return Math.round(base * (0.8 + 0.4 * rand()));
}

interface JobRow { id: number; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number; tenant_id: string | null }

/** Postgres-backed queue (docs/3_SCHEMAS.md 3.15/3.16): FOR UPDATE SKIP LOCKED, safe with several replicas. */
export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private running = false;
  private concurrency = 4;
  private pollMs = 1000;

  constructor(private readonly db: Queryable, private readonly opts: QueueOptions) {}

  get workerId(): string { return this.opts.workerId; }

  register(kind: string, handler: JobHandler): void { this.handlers.set(kind, handler); }

  /** Returns the new job id, or null when an open job with the same dedupe key already exists. */
  async enqueue(kind: string, payload: Record<string, unknown> = {}, o: EnqueueOptions = {}): Promise<number | null> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO jobs (kind, payload, dedupe_key, run_at, max_attempts, tenant_id) VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6)
       ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running') DO NOTHING RETURNING id`,
      [kind, JSON.stringify(payload), o.dedupeKey ?? null, o.runAt ?? null, o.maxAttempts ?? 6, currentTenantId() ?? null]); // the business that enqueues it is the business it runs as
    return rows[0]?.id ?? null;
  }

  /** Claims up to `limit` due jobs and runs them to completion. Returns how many were claimed. */
  async runOnce(limit = 1): Promise<number> {
    // A job whose worker died too many times is dead, not retried forever.
    await this.db.query("UPDATE jobs SET status = 'dead', last_error = COALESCE(last_error, 'worker died'), updated_at = now() WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts");
    const { rows } = await this.db.query<JobRow>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = now() + make_interval(secs => $2), updated_at = now()
       WHERE id IN (SELECT id FROM jobs WHERE (status = 'pending' AND run_at <= now()) OR (status = 'running' AND locked_until < now())
                    ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $1)
       RETURNING id, kind, payload, attempts, max_attempts, tenant_id`, [limit, this.opts.lockSeconds ?? 300]);
    await Promise.all(rows.map((r) => this.execute({ id: r.id, kind: r.kind, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts, tenantId: r.tenant_id })));
    return rows.length;
  }

  private async execute(job: Job): Promise<void> {
    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) throw new PermanentJobError(`no handler for job kind "${job.kind}"`);
      // The handler runs as the business that enqueued the job, whichever worker picked it up (row-level security applies inside it).
      await (job.tenantId ? runWithTenant(job.tenantId, () => handler(job)) : handler(job));
      await this.db.query("UPDATE jobs SET status = 'done', locked_until = NULL, updated_at = now() WHERE id = $1", [job.id]);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const dead = err instanceof PermanentJobError || job.attempts >= job.maxAttempts;
      this.opts.onError?.(err, job);
      await this.db.query(
        `UPDATE jobs SET status = $2, last_error = $3, locked_until = NULL, run_at = now() + make_interval(secs => $4), updated_at = now() WHERE id = $1`,
        [job.id, dead ? 'dead' : 'pending', message, dead ? 0 : backoffMs(job.attempts) / 1000]);
    }
  }

  async heartbeat(): Promise<void> {
    await this.db.query(
      'INSERT INTO worker_heartbeats (worker_id, seen_at) VALUES ($1, now()) ON CONFLICT (worker_id) DO UPDATE SET seen_at = now()', [this.opts.workerId]);
  }

  start({ concurrency = 4, pollMs = 1000 }: StartOptions = {}): void {
    if (this.running) return;
    this.running = true;
    this.concurrency = concurrency;
    this.pollMs = pollMs;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      const p = this.tick().finally(() => { this.inFlight.delete(p); this.schedule(this.pollMs); });
      this.inFlight.add(p);
    }, delay);
  }

  private async tick(): Promise<void> {
    try {
      await this.heartbeat();
      let claimed: number;
      do { claimed = await this.runOnce(this.concurrency); } while (this.running && claimed === this.concurrency);
    } catch (err) {
      this.opts.onError?.(err); // database hiccup: try again on the next poll
    }
  }

  /** Stops polling and waits for in-flight jobs to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.all([...this.inFlight]);
  }
}
