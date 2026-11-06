import { normaliseReply, optionsOf, truncate, type BotReply } from './reply.js';
import { postJson, type ChannelAdapter } from './types.js';

export interface MetaPageConfig { token?: string; graphVersion: string; graphBase?: string }

const MAX_TEXT = 2000;
const MAX_QUICK_REPLIES = 13;

/** Facebook Messenger and Instagram Direct both use the Page Send API. */
export class MetaPageAdapter implements ChannelAdapter {
  constructor(
    readonly name: 'messenger' | 'instagram',
    private readonly cfg: MetaPageConfig,
    private readonly fetchFn: typeof fetch,
  ) {}

  isConfigured(): boolean { return Boolean(this.cfg.token); }

  async send(to: string, text: string): Promise<void> {
    await this.post(to, { text: text.slice(0, MAX_TEXT) });
  }

  /** Options → quick replies (titles ≤ 20); list details and links are written into the text so nothing is lost. */
  async sendReply(to: string, input: BotReply): Promise<void> {
    const r = normaliseReply(input);
    const parts = [r.text];
    if (r.list) {
      // The message body has no 24-char row limit: show the original (untruncated) names for the kept rows.
      const original = new Map((input.list?.sections ?? []).flatMap((s) => s.rows).map((row) => [row.id, row]));
      parts.push(r.list.sections.flatMap((s) => s.rows).map((row) => {
        const full = original.get(row.id) ?? row;
        return `• ${full.title}${full.description ? ` — ${full.description}` : ''}`;
      }).join('\n'));
    }
    if (r.link) parts.push(`${r.link.label}: ${r.link.url}`);
    const quickReplies = optionsOf(r).slice(0, MAX_QUICK_REPLIES).map((o) => ({ content_type: 'text', title: truncate(o.title, 20), payload: o.id }));
    await this.post(to, { text: parts.join('\n\n').slice(0, MAX_TEXT), ...(quickReplies.length ? { quick_replies: quickReplies } : {}) });
  }

  private async post(to: string, message: Record<string, unknown>): Promise<void> {
    await postJson(this.name, this.fetchFn, `${(this.cfg.graphBase ?? 'https://graph.facebook.com').replace(/\/$/, '')}/${this.cfg.graphVersion}/me/messages`, {
      recipient: { id: to },
      messaging_type: 'RESPONSE',
      message,
    }, { authorization: `Bearer ${this.cfg.token}` });
  }
}
