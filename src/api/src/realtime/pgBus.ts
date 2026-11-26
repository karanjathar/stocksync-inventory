import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Logger } from 'pino';
import { runWithTenant } from '../db/tenant.js';
import type { RealtimeEvent } from '../domain/types.js';
import type { EventBus } from './bus.js';

const CHANNEL = 'stocksync_events';
/** PostgreSQL refuses NOTIFY payloads of 8000 bytes or more; anything near that travels as a reference to a row instead. */
export const INLINE_LIMIT_BYTES = 7000;
const REFERENCE_TTL_MINUTES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Wire { o: string; t: string; e?: RealtimeEvent; ref?: string }
type Queryable = Pick<pg.Pool, 'query'>;

/**
 * Carries dashboard events between API replicas over PostgreSQL LISTEN/NOTIFY (D-022). Each replica publishes locally at once and sends a
 * notification; every OTHER replica turns notifications into deliveries to its own SSE clients, for the business named in the message only.
 * The listener reconnects on its own. Missed events during a reconnect are not replayed (clients refetch on reconnect).
 */
export class PgBus {
  readonly origin = randomUUID();
  private listener?: pg.Client;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private attempts = 0;

  constructor(private readonly opts: { connectionString: string; ssl: boolean; pool: Queryable; logger: Logger }, private readonly bus: EventBus) {}

  async start(): Promise<void> {
    this.bus.setTransport((tenantId, e) => { void this.send(tenantId, e).catch((err: unknown) => this.opts.logger.warn({ err: String(err) }, 'realtime notify failed')); });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.opts.connectionString, ssl: this.opts.ssl ? { rejectUnauthorized: true } : undefined });
    client.on('notification', (m) => { if (m.channel === CHANNEL && m.payload) void this.receive(m.payload).catch((err: unknown) => this.opts.logger.warn({ err: String(err) }, 'realtime delivery failed')); });
    client.on('error', (err) => { this.opts.logger.warn({ err: String(err) }, 'realtime listener error'); this.reconnect(client); });
    client.on('end', () => this.reconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client; this.attempts = 0;
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, 'realtime listener could not connect');
      client.removeAllListeners(); void client.end().catch(() => undefined);
      this.schedule();
    }
  }

  private reconnect(client: pg.Client): void {
    if (this.listener !== client) return;
    this.listener = undefined;
    client.removeAllListeners(); void client.end().catch(() => undefined);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.retry) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempts++, 6));
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, delay);
    this.retry.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const l = this.listener; this.listener = undefined;
    l?.removeAllListeners();
    await l?.end().catch(() => undefined);
  }

  /** Sends an event to the other replicas (runs inside the publisher's business context so the reference row belongs to it). */
  private async send(tenantId: string, e: RealtimeEvent): Promise<void> {
    await runWithTenant(tenantId, async () => {
      let wire: Wire = { o: this.origin, t: tenantId, e };
      if (Buffer.byteLength(JSON.stringify(wire)) > INLINE_LIMIT_BYTES) {
        await this.opts.pool.query(`DELETE FROM realtime_payloads WHERE created_at < now() - make_interval(mins => $1)`, [REFERENCE_TTL_MINUTES]);
        const id = (await this.opts.pool.query<{ id: string }>('INSERT INTO realtime_payloads (payload) VALUES ($1) RETURNING id', [JSON.stringify(e)])).rows[0]!.id;
        wire = { o: this.origin, t: tenantId, ref: id };
      }
      await this.opts.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(wire)]);
    });
  }

  private async receive(raw: string): Promise<void> {
    let wire: Wire;
    try { wire = JSON.parse(raw) as Wire; } catch { return; }
    if (wire.o === this.origin || typeof wire.t !== 'string' || !UUID.test(wire.t)) return; // our own, or malformed
    let event = wire.e;
    if (!event && typeof wire.ref === 'string' && UUID.test(wire.ref)) {
      // The row is read inside the NAMED business's context: row-level security means a forged tenant id can only ever find that business's own rows.
      event = await runWithTenant(wire.t, async () => (await this.opts.pool.query<{ payload: RealtimeEvent }>('SELECT payload FROM realtime_payloads WHERE id = $1', [wire.ref])).rows[0]?.payload);
    }
    if (event) this.bus.deliverRemote(wire.t, event);
  }
}
