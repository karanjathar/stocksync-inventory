import { normaliseReply, type BotReply } from './reply.js';
import { postJson, type ChannelAdapter, type TemplateMessage } from './types.js';

export interface WhatsAppConfig { token?: string; phoneNumberId?: string; graphVersion: string; graphBase?: string }

/** WhatsApp Business Cloud API (Meta): text and interactive (button, list, cta_url) messages. */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = 'whatsapp' as const;
  constructor(private readonly cfg: WhatsAppConfig, private readonly fetchFn: typeof fetch) {}

  isConfigured(): boolean { return Boolean(this.cfg.token && this.cfg.phoneNumberId); }

  async send(to: string, text: string): Promise<string | undefined> {
    return this.post(to, { type: 'text', text: { preview_url: false, body: text.slice(0, 4096) } });
  }

  async sendReply(to: string, input: BotReply): Promise<string | undefined> {
    const r = normaliseReply(input);
    const body = { text: r.text };
    if (r.buttons) {
      return this.post(to, { type: 'interactive', interactive: { type: 'button', body,
        action: { buttons: r.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } });
    } else if (r.list) {
      return this.post(to, { type: 'interactive', interactive: { type: 'list', body,
        action: { button: r.list.button, sections: r.list.sections } } });
    } else if (r.link) {
      return this.post(to, { type: 'interactive', interactive: { type: 'cta_url', body,
        action: { name: 'cta_url', parameters: { display_text: r.link.label, url: r.link.url } } } });
    } else {
      return this.send(to, r.text);
    }
  }

  async sendTemplate(to: string, t: TemplateMessage): Promise<string | undefined> {
    return this.post(to, { type: 'template', template: { name: t.name, language: { code: t.language },
      ...(t.params.length ? { components: [{ type: 'body', parameters: t.params.map((text) => ({ type: 'text', text: text.slice(0, 1024) })) }] } : {}) } });
  }

  private async post(to: string, message: Record<string, unknown>): Promise<string | undefined> {
    const res = await postJson(this.name, this.fetchFn, `${(this.cfg.graphBase ?? 'https://graph.facebook.com').replace(/\/$/, '')}/${this.cfg.graphVersion}/${this.cfg.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/[^0-9]/g, ''),
      ...message,
    }, { authorization: `Bearer ${this.cfg.token}` }) as { messages?: { id?: string }[] } | undefined;
    return res?.messages?.[0]?.id;
  }
}
