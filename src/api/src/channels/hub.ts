import type { ChannelName } from '../domain/types.js';
import { ValidationError } from '../domain/errors.js';
import type { MessagesRepo } from '../repositories/messages.js';
import type { Messenger } from '../services/messenger.js';
import type { ChannelAdapter } from './types.js';
import { TelegramAdapter } from './telegram.js';
import { normaliseReply, optionsOf, renderPlain, type BotReply } from './reply.js';

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

  /** Sends a rich reply rendered by the channel adapter (or numbered text) and logs it with the options shown. */
  async reply(channel: ChannelName, to: string, input: BotReply): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new ValidationError(`Unknown channel: ${channel}`);
    const reply = normaliseReply(input);
    const text = renderPlain(reply);
    const options = optionsOf(reply);
    if (!adapter.isConfigured()) {
      await this.log.logOutbound(channel, to, text, 'skipped', options);
      return;
    }
    try {
      if (adapter.sendReply) await adapter.sendReply(to, reply);
      else await adapter.send(to, text);
      await this.log.logOutbound(channel, to, text, 'ok', options);
    } catch (err) {
      await this.log.logOutbound(channel, to, text, 'failed', options);
      throw err;
    }
  }

  async send(channel: ChannelName, to: string, text: string): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new ValidationError(`Unknown channel: ${channel}`);
    if (!adapter.isConfigured()) {
      await this.log.logOutbound(channel, to, text, 'skipped');
      return;
    }
    try {
      await adapter.send(to, text);
      await this.log.logOutbound(channel, to, text, 'ok');
    } catch (err) {
      await this.log.logOutbound(channel, to, text, 'failed');
      throw err;
    }
  }
}
