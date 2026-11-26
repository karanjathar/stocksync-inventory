import type { Queryable } from '../db/pool.js';
import type { ChannelName, Customer } from '../domain/types.js';
import { SimpleRepo } from './simple.js';

export class CustomersRepo extends SimpleRepo<Customer> {
  constructor(private readonly q: Queryable) {
    super(q, 'customers',
      { name: 'name', phone: 'phone', email: 'email', channel: 'channel', channelUserId: 'channel_user_id', gstin: 'gstin', stateCode: 'state_code' },
      'created_at DESC', ['name', 'phone', 'email']);
  }

  /** Upserts the customer behind a chat identity; existing records are never overwritten. */
  async findOrCreateByChannel(channel: ChannelName | 'web', channelUserId: string, displayName: string | undefined): Promise<Customer> {
    const name = displayName?.trim().slice(0, 120) || `${channel} user ${channelUserId}`;
    const phone = channel === 'whatsapp' || channel === 'web' ? `+${channelUserId.replace(/^\+/, '')}` : null;
    await this.q.query(
      `INSERT INTO customers (name, phone, channel, channel_user_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, channel, channel_user_id) DO NOTHING`, [name, phone, channel, channelUserId]);
    const { rows } = await this.q.query<{ id: string }>(
      'SELECT id FROM customers WHERE channel = $1 AND channel_user_id = $2', [channel, channelUserId]);
    return (await this.get(rows[0]!.id))!;
  }
}
