import type pg from 'pg';
import type { Logger } from 'pino';
import type { Queryable } from '../db/pool.js';
import { DEFAULT_TENANT_ID } from '../db/tenant.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';

export const HOLD_DAYS = 30;
export interface DeletionState { requested: boolean; requestedAt: string | null; eraseAfter: string | null; holdDays: number }

/** The business's side of data rights: ask for deletion (30-day hold, cancellable) and erase one customer's personal data. */
export class DataRights {
  constructor(private readonly db: Queryable) {}

  async deletionState(): Promise<DeletionState> {
    const r = (await this.db.query<{ requestedAt: string; eraseAfter: string }>(
      'SELECT requested_at AS "requestedAt", erase_after AS "eraseAfter" FROM deletion_requests WHERE tenant_id = current_tenant() AND cancelled_at IS NULL')).rows[0];
    return { requested: !!r, requestedAt: r?.requestedAt ?? null, eraseAfter: r?.eraseAfter ?? null, holdDays: HOLD_DAYS };
  }

  async requestDeletion(tenantId: string, by: string): Promise<DeletionState> {
    if (tenantId === DEFAULT_TENANT_ID) throw new ConflictError('The original business of this installation cannot be deleted from the app');
    await this.db.query(
      `INSERT INTO deletion_requests (requested_by, erase_after) VALUES ($1, now() + make_interval(days => $2))
       ON CONFLICT (tenant_id) DO UPDATE SET requested_by = EXCLUDED.requested_by, requested_at = now(), erase_after = EXCLUDED.erase_after, cancelled_at = NULL
       WHERE deletion_requests.cancelled_at IS NOT NULL`, [by, HOLD_DAYS]); // an open request is left exactly as it was (the clock does not restart)
    return this.deletionState();
  }

  async cancelDeletion(): Promise<DeletionState> {
    await this.db.query('UPDATE deletion_requests SET cancelled_at = now() WHERE tenant_id = current_tenant() AND cancelled_at IS NULL');
    return this.deletionState();
  }

  /**
   * Removes a customer's personal data while keeping the business's records: orders, payments and stock history stay with their amounts, but the
   * name, contact details, GSTIN, order notes, chat history and saved cart go. GST invoices already issued keep their snapshot: tax law requires
   * the buyer details on them to be retained. Safe to repeat.
   */
  async eraseCustomer(id: string): Promise<{ erased: boolean; messages: number; orders: number }> {
    const c = (await this.db.query<{ channel: string; phone: string | null; channelUserId: string | null; erasedAt: string | null }>(
      'SELECT channel, phone, channel_user_id AS "channelUserId", erased_at AS "erasedAt" FROM customers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!c) throw new NotFoundError('Customer');
    if (c.erasedAt) return { erased: false, messages: 0, orders: 0 };
    // WhatsApp and SMS-style channels identify people by phone number, whatever channel the customer record was created from.
    const phones = [c.phone, c.phone?.replace(/[^0-9]/g, '')].filter((h): h is string => !!h);
    const handles = [...phones, ...(c.channelUserId ? [c.channelUserId] : [])];
    const messages = handles.length ? (await this.db.query(
      `UPDATE channel_messages SET text = '[erased]', payload = NULL, options = NULL, external_id = NULL, error_message = NULL, external_user = 'erased'
       WHERE external_user = ANY($2) AND (channel = $1 OR external_user = ANY($3))`, [c.channel, handles, phones])).rowCount ?? 0 : 0;
    const orders = (await this.db.query(`UPDATE orders SET notes = '' WHERE customer_id = $1 AND notes <> ''`, [id])).rowCount ?? 0;
    await this.db.query('DELETE FROM chat_carts WHERE customer_id = $1', [id]);
    await this.db.query(
      `UPDATE customers SET name = 'Erased customer', phone = NULL, email = NULL, channel_user_id = NULL, gstin = NULL, state_code = NULL, erased_at = now() WHERE id = $1`, [id]);
    return { erased: true, messages, orders };
  }
}

/** The platform's side: erases businesses whose hold has ended. Runs on the platform role; the database function re-checks the request itself. */
export class TenantEraser {
  constructor(private readonly pool: pg.Pool, private readonly logger: Logger, private readonly afterErase?: (tenantId: string) => Promise<void>) {}

  async runDue(): Promise<number> {
    const due = (await this.pool.query<{ tenantId: string }>(
      'SELECT tenant_id AS "tenantId" FROM deletion_requests WHERE cancelled_at IS NULL AND erase_after <= now()')).rows;
    let done = 0;
    for (const { tenantId } of due) {
      try {
        const removed = (await this.pool.query<{ n: number }>('SELECT tenant_erase($1) AS n', [tenantId])).rows[0]?.n ?? 0;
        this.logger.warn({ tenantId, removed }, 'business erased after its deletion hold');
        await this.afterErase?.(tenantId).catch((err: unknown) => this.logger.error({ err: String(err), tenantId }, 'could not remove the business\'s files'));
        done++;
      } catch (err) {
        this.logger.error({ err: String(err), tenantId }, 'business erasure failed (rolled back, will retry)');
      }
    }
    return done;
  }
}
