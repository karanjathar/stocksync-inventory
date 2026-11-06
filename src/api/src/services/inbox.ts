import type { Logger } from 'pino';
import type { InboundMessage } from '../domain/types.js';
import type { EventBus } from '../realtime/bus.js';
import type { MessagesRepo } from '../repositories/messages.js';
import type { BotService } from './bot.js';
import type { Messenger } from './messenger.js';
import { renderPlain, resolveNumberedChoice } from '../channels/reply.js';

/** Inbound chat pipeline: de-duplicate → log → notify dashboard → bot reply. */
export class InboxService {
  constructor(
    private readonly messages: MessagesRepo,
    private readonly events: EventBus,
    private readonly bot: BotService,
    private readonly messenger: Messenger,
    private readonly logger: Logger,
  ) {}

  async receive(input: InboundMessage): Promise<void> {
    let msg = input;
    if (msg.action && msg.text === msg.action) {
      // Label-less tap (Telegram callback_query): show staff the option title instead of the raw action id.
      const option = (await this.messages.lastOptions(msg.channel, msg.from)).find((o) => o.id === msg.action);
      if (option) msg = { ...msg, text: option.title };
    }
    const text = msg.text.trim();
    if (!text) return;
    const fresh = await this.messages.logInbound({ ...msg, text });
    if (!fresh) return; // webhook retry of an already-processed message
    this.events.publish({ type: 'message.received', channel: msg.channel, from: msg.from, text: text.slice(0, 500) });
    try {
      let action = msg.action;
      if (!action && /^\s*\d{1,2}\s*$/.test(text)) {
        // Numbered answer to options shown on a channel without rich UI (D-009).
        action = resolveNumberedChoice(text, await this.messages.lastOptions(msg.channel, msg.from));
      }
      const reply = await this.bot.handle({ ...msg, text, ...(action ? { action } : {}) });
      if (this.messenger.reply) await this.messenger.reply(msg.channel, msg.from, reply);
      else await this.messenger.send(msg.channel, msg.from, renderPlain(reply));
    } catch (err) {
      this.logger.error({ err, channel: msg.channel }, 'failed to process inbound message');
    }
  }
}
