import type { ChannelName, NotificationEvent, TemplateParam } from '../domain/types.js';
import type { BotReply } from '../channels/reply.js';

/** Marks a proactive (business-initiated) notification so WhatsApp can fall back to an approved template. */
export interface NotifyOpts { event?: NotificationEvent; params?: Partial<Record<TemplateParam, string>> }

/** Outbound chat delivery port; implemented by ChannelHub. */
export interface Messenger {
  send(channel: ChannelName, to: string, text: string, opts?: NotifyOpts): Promise<void>;
  /** Rich reply (buttons/list/link). Optional: callers fall back to send(renderPlain(reply)). */
  reply?(channel: ChannelName, to: string, reply: BotReply, opts?: NotifyOpts): Promise<void>;
}
