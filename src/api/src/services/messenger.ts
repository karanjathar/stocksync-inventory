import type { ChannelName } from '../domain/types.js';
import type { BotReply } from '../channels/reply.js';

/** Outbound chat delivery port; implemented by ChannelHub. */
export interface Messenger {
  send(channel: ChannelName, to: string, text: string): Promise<void>;
  /** Rich reply (buttons/list/link). Optional: callers fall back to send(renderPlain(reply)). */
  reply?(channel: ChannelName, to: string, reply: BotReply): Promise<void>;
}

