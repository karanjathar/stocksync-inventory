import type { Queryable } from '../db/pool.js';
import type { ChannelMessage, ChannelName, InboundMessage } from '../domain/types.js';
import type { BotReply, ReplyOption } from '../channels/reply.js';

/** What is needed to (re)send a stored outbound message. */
export type OutboundPayload = { kind: 'text'; text: string } | { kind: 'reply'; reply: BotReply };

// Legacy outbound rows written as 'ok' read as 'sent' (docs/3_SCHEMAS.md 3.15).
const COLS = `id, channel, direction, external_user AS "externalUser", text,
  CASE WHEN direction = 'out' AND status = 'ok' THEN 'sent' ELSE status END AS status,
  created_at AS "createdAt", error_code AS "errorCode", error_message AS "errorMessage"`;

export class MessagesRepo {
  constructor(private readonly db: Queryable) {}

  /** Returns false when this external message id was already processed (webhook retry). */
  async logInbound(m: InboundMessage): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO channel_messages (channel, direction, external_user, external_id, text, created_at)
       VALUES ($1, 'in', $2, $3, $4, clock_timestamp()) ON CONFLICT (external_id) DO NOTHING`,
      [m.channel, m.from, m.externalId ?? null, m.text.slice(0, 4096)],
    );
    return (rowCount ?? 0) > 0;
  }

  async logOutbound(channel: ChannelName, to: string, text: string, status: 'ok' | 'failed' | 'skipped', options: ReplyOption[] = []): Promise<void> {
    await this.db.query(
      `INSERT INTO channel_messages (channel, direction, external_user, text, status, options, created_at)
       VALUES ($1, 'out', $2, $3, $4, $5, clock_timestamp())`,
      [channel, to, text.slice(0, 4096), status, options.length ? JSON.stringify(options) : null],
    );
  }

  /**
   * Stores an outbound message. `queued` messages get their `message.send` job in the SAME statement, so a crash
   * between storing and sending still ends in exactly one send by the worker (30 s grace for the immediate attempt).
   */
  async createOutbound(m: { channel: ChannelName; to: string; text: string; payload: OutboundPayload; status: 'queued' | 'skipped';
    options?: ReplyOption[]; event?: string }): Promise<string> {
    const args = [m.channel, m.to, m.text.slice(0, 4096), m.status, m.options?.length ? JSON.stringify(m.options) : null, JSON.stringify(m.payload), m.event ?? null];
    const insert = `INSERT INTO channel_messages (channel, direction, external_user, text, status, options, payload, event, created_at)
       VALUES ($1, 'out', $2, $3, $4, $5, $6, $7, clock_timestamp()) RETURNING id`;
    const sql = m.status === 'queued'
      ? `WITH m AS (${insert}), j AS (INSERT INTO jobs (kind, payload, dedupe_key, run_at)
           SELECT 'message.send', jsonb_build_object('messageId', id), id::text, now() + interval '30 seconds' FROM m) SELECT id FROM m`
      : insert;
    const { rows } = await this.db.query<{ id: string }>(sql, args);
    return rows[0]!.id;
  }

  async getForDelivery(id: string): Promise<{ id: string; channel: ChannelName; to: string; text: string; status: string; payload: OutboundPayload | null } | null> {
    const { rows } = await this.db.query(
      `SELECT id, channel, external_user AS "to", text, status, payload FROM channel_messages WHERE id = $1 AND direction = 'out'`, [id]);
    return rows[0] ?? null;
  }

  async markSent(id: string, providerId: string | undefined): Promise<void> {
    await this.db.query(
      `UPDATE channel_messages SET status = 'sent', provider_message_id = $2, attempts = attempts + 1, error_code = NULL, error_message = NULL, status_at = now()
       WHERE id = $1 AND status = 'queued'`, [id, providerId ?? null]);
  }

  /** A retryable failure: the message stays queued and the job retries it. */
  async recordAttempt(id: string, code: string, message: string): Promise<void> {
    await this.db.query('UPDATE channel_messages SET attempts = attempts + 1, error_code = $2, error_message = $3 WHERE id = $1 AND status = $4',
      [id, code, message.slice(0, 500), 'queued']);
  }

  async markFailed(id: string, code: string, message: string): Promise<void> {
    await this.db.query(
      `UPDATE channel_messages SET status = 'failed', attempts = attempts + 1, error_code = $2, error_message = $3, status_at = now()
       WHERE id = $1 AND status = 'queued'`, [id, code, message.slice(0, 500)]);
  }

  /**
   * Applies a provider delivery receipt. Only moves forward (queued → sent → delivered → read); `failed` is terminal
   * and never overrides a failure. Returns the updated message, or null when unknown / not an advance (replay, late receipt).
   */
  async applyDeliveryStatus(channel: ChannelName, providerId: string, status: 'sent' | 'delivered' | 'read' | 'failed',
    err: { code?: string; title?: string } = {}): Promise<{ id: string; to: string } | null> {
    const { rows } = await this.db.query<{ id: string; to: string }>(
      `UPDATE channel_messages SET status = $3, status_at = now(),
         error_code = CASE WHEN $3 = 'failed' THEN COALESCE($4, error_code) ELSE error_code END,
         error_message = CASE WHEN $3 = 'failed' THEN COALESCE($5, error_message) ELSE error_message END
       WHERE channel = $1 AND provider_message_id = $2 AND direction = 'out' AND status <> 'failed'
         AND ($3 = 'failed' OR COALESCE(array_position(ARRAY['queued','sent','delivered','read'], status), 0) < array_position(ARRAY['queued','sent','delivered','read'], $3))
       RETURNING id, external_user AS "to"`, [channel, providerId, status, err.code ?? null, err.title ?? null]);
    return rows[0] ?? null;
  }

  /** Options of the latest message sent to this user ([] if that message had none). */
  async lastOptions(channel: ChannelName, user: string): Promise<ReplyOption[]> {
    const { rows } = await this.db.query<{ options: ReplyOption[] | null }>(
      `SELECT options FROM channel_messages WHERE channel = $1 AND external_user = $2 AND direction = 'out'
       ORDER BY created_at DESC LIMIT 1`, [channel, user]);
    return rows[0]?.options ?? [];
  }

  async list(f: { channel?: ChannelName; limit?: number }): Promise<ChannelMessage[]> {
    const values: unknown[] = [];
    let where = '';
    if (f.channel) {
      values.push(f.channel);
      where = 'WHERE channel = $1';
    }
    values.push(Math.min(f.limit ?? 100, 500));
    const { rows } = await this.db.query<ChannelMessage>(
      `SELECT ${COLS} FROM channel_messages ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    return rows;
  }
}
