import type { ChannelName } from '../domain/types.js';
import { ValidationError } from '../domain/errors.js';
import type { MessagesRepo, OutboundPayload } from '../repositories/messages.js';
import type { Messenger } from '../services/messenger.js';
import { ChannelError, isRetryable, type ChannelAdapter } from './types.js';
import { TelegramAdapter } from './telegram.js';
import { normaliseReply, optionsOf, renderPlain, type BotReply } from './reply.js';
import { PermanentJobError } from '../jobs/queue.js';

export class ChannelHub implements Messenger {
  private readonly adapters: Map<ChannelName, ChannelAdapter>;

  constructor(adapters: ChannelAdapter[], private readonly log: MessagesRepo) {
    this.adapters = new Map(adapters.map((a) => [a.name, a]));
  }

  status(): { name: ChannelName; configured: boolean }[] {
    return [...this.adapters.values()].map((a) => ({ name: a.name, configured: a.isConfigured() }));
  }

  /** Acknowledge a Telegram inline-button tap (stops the client spinner). Best effort. */
  async acknowledgeTap(channel: ChannelName, tapId: string): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter?.isConfigured() || !(adapter instanceof TelegramAdapter)) return;
    await adapter.answerCallbackQuery(tapId);
  }

  /** Sends a rich reply rendered by the channel adapter (or numbered text), stored first so it can be retried. */
  async reply(channel: ChannelName, to: string, input: BotReply): Promise<void> {
    const reply = normaliseReply(input);
    await this.dispatch(channel, to, renderPlain(reply), { kind: 'reply', reply }, optionsOf(reply));
  }

  async send(channel: ChannelName, to: string, text: string): Promise<void> {
    await this.dispatch(channel, to, text, { kind: 'text', text });
  }

  /**
   * Outbox: store → try now. A retryable failure leaves the message `queued` for the worker (no error to the caller,
   * nothing is lost); a permanent failure marks it `failed` and is rethrown.
   */
  private async dispatch(channel: ChannelName, to: string, text: string, payload: OutboundPayload, options = optionsOf({ text })): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new ValidationError(`Unknown channel: ${channel}`);
    const id = await this.log.createOutbound({ channel, to, text, payload, options, status: adapter.isConfigured() ? 'queued' : 'skipped' });
    if (!adapter.isConfigured()) return;
    await this.deliver(id, { immediate: true });
  }

  /** Sends a stored message if it is still `queued`. Used for the first attempt and by the `message.send` job. */
  async deliver(id: string, o: { immediate?: boolean; finalAttempt?: boolean } = {}): Promise<void> {
    const m = await this.log.getForDelivery(id);
    if (!m || m.status !== 'queued') return; // already sent, failed or gone: nothing to do (idempotent)
    const adapter = this.adapters.get(m.channel);
    try {
      if (!adapter?.isConfigured()) throw new ChannelError(m.channel, 400, 'channel is not configured');
      const payload: OutboundPayload = m.payload ?? { kind: 'text', text: m.text };
      const providerId = payload.kind === 'reply' && adapter.sendReply ? await adapter.sendReply(m.to, payload.reply) : await adapter.send(m.to, textOf(payload, m.text));
      await this.log.markSent(id, providerId ?? undefined);
    } catch (err) {
      const code = err instanceof ChannelError ? String(err.status) : 'NETWORK';
      const message = err instanceof Error ? err.message : String(err);
      if (isRetryable(err) && !o.finalAttempt) {
        await this.log.recordAttempt(id, code, message);
        if (o.immediate) return; // durable: the job retries with backoff
        throw err;
      }
      await this.log.markFailed(id, code, message);
      if (o.immediate) throw err;
      throw new PermanentJobError(message);
    }
  }
}

function textOf(payload: OutboundPayload, fallback: string): string {
  return payload.kind === 'text' ? payload.text : fallback;
}
