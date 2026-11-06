import { normaliseReply, optionsOf, truncate, type BotReply } from './reply.js';
import { postJson, type ChannelAdapter } from './types.js';

type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram' as const;
  constructor(private readonly cfg: { token?: string }, private readonly fetchFn: typeof fetch) {}

  isConfigured(): boolean { return Boolean(this.cfg.token); }

  async send(to: string, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: to, text: text.slice(0, 4096) });
  }

  /** Options become one inline button per row (callback_data = action id, ≤ 64 bytes); links become url buttons. */
  async sendReply(to: string, input: BotReply): Promise<void> {
    const r = normaliseReply(input);
    let keyboard: InlineButton[][] = [];
    if (r.buttons) keyboard = r.buttons.map((b) => [{ text: b.title, callback_data: b.id }]);
    else if (r.list) {
      keyboard = r.list.sections.flatMap((s) => s.rows).map((row) => [{
        text: truncate(row.description ? `${row.title} · ${row.description}` : row.title, 64),
        callback_data: row.id,
      }]);
    } else if (r.link) keyboard = [[{ text: r.link.label, url: r.link.url }]];
    if (!keyboard.length || !optionsOf(r).length && !r.link) {
      await this.send(to, r.text);
      return;
    }
    await this.call('sendMessage', { chat_id: to, text: r.text, reply_markup: { inline_keyboard: keyboard } });
  }

  /** Stops the loading spinner on the tapped inline button. */
  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<void> {
    await postJson(this.name, this.fetchFn, `https://api.telegram.org/bot${this.cfg.token}/${method}`, body);
  }
}
