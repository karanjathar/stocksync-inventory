import type pg from 'pg';
import type { Logger } from 'pino';
import type { OrdersService } from '../services/orders.js';
import type { SettingsService } from '../services/settings.js';
import type { JobQueue } from './queue.js';

const BATCH = 5000;

/** Housekeeping jobs (FR-R3-5). Each run is recorded in maintenance_runs for the ops status. */
export class Maintenance {
  constructor(private readonly pool: pg.Pool, private readonly orders: OrdersService, private readonly settings: SettingsService, private readonly logger: Logger) {}

  register(queue: JobQueue): void {
    queue.register('maintenance.expireUnpaid', async () => { await this.expireUnpaid(); });
    queue.register('maintenance.prune', async () => { await this.prune(); });
  }

  /** Cancels UNPAID ONLINE orders that are still PENDING after the TTL. Paid, COD, confirmed and fresh orders are never touched. */
  async expireUnpaid(): Promise<{ cancelled: number }> {
    const { maintenance } = await this.settings.get();
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM orders WHERE status = 'PENDING' AND payment_method = 'ONLINE' AND payment_status = 'UNPAID'
         AND created_at < now() - make_interval(hours => $1) ORDER BY created_at LIMIT 200`, [maintenance.unpaidOrderTtlHours]);
    let cancelled = 0;
    for (const { id } of rows) {
      try {
        await this.orders.cancel(id, null); // observers cancel the Razorpay link and tell chat customers
        cancelled++;
      } catch (err) {
        this.logger.warn({ err: String(err), orderId: id }, 'could not expire unpaid order'); // e.g. paid or confirmed meanwhile
      }
    }
    const result = { cancelled };
    await this.record('expireUnpaid', result);
    return result;
  }

  /** Deletes webhook dedupe rows older than 30 days and chat messages beyond the retention period (0 = keep forever). */
  async prune(): Promise<{ webhookEventsDeleted: number; messagesDeleted: number }> {
    const { maintenance } = await this.settings.get();
    const webhookEventsDeleted = await this.deleteInBatches(
      "DELETE FROM webhook_events WHERE ctid IN (SELECT ctid FROM webhook_events WHERE received_at < now() - interval '30 days' LIMIT $1)", []);
    const messagesDeleted = maintenance.chatRetentionDays > 0 ? await this.deleteInBatches(
      `DELETE FROM channel_messages WHERE id IN (SELECT id FROM channel_messages WHERE created_at < now() - make_interval(days => $2)
         AND NOT (direction = 'out' AND status = 'queued') LIMIT $1)`, [maintenance.chatRetentionDays]) : 0;
    const result = { webhookEventsDeleted, messagesDeleted };
    await this.record('prune', result);
    return result;
  }

  private async deleteInBatches(sql: string, args: unknown[]): Promise<number> {
    let total = 0;
    for (;;) {
      const { rowCount } = await this.pool.query(sql, [BATCH, ...args]);
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < BATCH) return total;
    }
  }

  private async record(task: string, result: object): Promise<void> {
    await this.pool.query(
      'INSERT INTO maintenance_runs (task, ran_at, result) VALUES ($1, now(), $2) ON CONFLICT (tenant_id, task) DO UPDATE SET ran_at = now(), result = EXCLUDED.result',
      [task, JSON.stringify(result)]);
  }
}
