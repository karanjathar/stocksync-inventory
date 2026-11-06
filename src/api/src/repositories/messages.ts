import type { Queryable } from '../db/pool.js';
import type { ChannelMessage, ChannelName, InboundMessage } from '../domain/types.js';
import type { ReplyOption } from '../channels/reply.js';

const COLS = `id, channel, direction, external_user AS "externalUser", text, status, created_at AS "createdAt"`;

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
