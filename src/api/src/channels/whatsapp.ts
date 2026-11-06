import { normaliseReply, type BotReply } from './reply.js';
import { postJson, type ChannelAdapter } from './types.js';

export interface WhatsAppConfig { token?: string; phoneNumberId?: string; graphVersion: string; graphBase?: string }

/** WhatsApp Business Cloud API (Meta): text and interactive (button, list, cta_url) messages. */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = 'whatsapp' as const;
  constructor(private readonly cfg: WhatsAppConfig, private readonly fetchFn: typeof fetch) {}

  isConfigured(): boolean { return Boolean(this.cfg.token && this.cfg.phoneNumberId); }

  async send(to: string, text: string): Promise<void> {
    await this.post(to, { type: 'text', text: { preview_url: false, body: text.slice(0, 4096) } });
  }

  async sendReply(to: string, input: BotReply): Promise<void> {
    const r = normaliseReply(input);
    const body = { text: r.text };
    if (r.buttons) {
      await this.post(to, { type: 'interactive', interactive: { type: 'button', body,
        action: { buttons: r.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } });
    } else if (r.list) {
      await this.post(to, { type: 'interactive', interactive: { type: 'list', body,
        action: { button: r.list.button, sections: r.list.sections } } });
    } else if (r.link) {
      await this.post(to, { type: 'interactive', interactive: { type: 'cta_url', body,
        action: { name: 'cta_url', parameters: { display_text: r.link.label, url: r.link.url } } } });
    } else {
      await this.send(to, r.text);
    }
  }

  private async post(to: string, message: Record<string, unknown>): Promise<void> {
    await postJson(this.name, this.fetchFn, `${(this.cfg.graphBase ?? 'https://graph.facebook.com').replace(/\/$/, '')}/${this.cfg.graphVersion}/${this.cfg.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/[^0-9]/g, ''),
      ...message,
    }, { authorization: `Bearer ${this.cfg.token}` });
  }
}
