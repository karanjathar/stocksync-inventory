import type { ChannelName, NotificationEvent, Settings, TemplateParam } from '../domain/types.js';
import { ValidationError } from '../domain/errors.js';
import type { MessagesRepo, OutboundPayload } from '../repositories/messages.js';
import type { Messenger, NotifyOpts } from '../services/messenger.js';
import { ChannelError, isRetryable, type ChannelAdapter, type TemplateMessage } from './types.js';
import { TelegramAdapter } from './telegram.js';
import { normaliseReply, optionsOf, renderPlain, type BotReply, type ReplyOption } from './reply.js';
import { PermanentJobError } from '../jobs/queue.js';

export class ChannelHub implements Messenger {
  private readonly adapters: Map<ChannelAdapter['name'], ChannelAdapter>;
  static readonly CHANNELS: ChannelName[] = ['whatsapp', 'messenger', 'instagram', 'telegram'];

  /**
   * `getSettings` supplies the event → WhatsApp template mapping (Settings → WhatsApp templates).
   * `resolver`, when given, supplies the adapter of the CURRENT business at call time (each business has its own credentials);
   * without it the fixed `adapters` are used.
   */
  constructor(adapters: ChannelAdapter[], private readonly log: MessagesRepo, private readonly getSettings?: () => Promise<Settings>,
    private readonly resolver?: (channel: ChannelName) => Promise<ChannelAdapter>) {
    this.adapters = new Map(adapters.map((a) => [a.name, a]));
  }

  private async adapterFor(channel: ChannelName): Promise<ChannelAdapter | undefined> {
    return this.resolver ? this.resolver(channel) : this.adapters.get(channel);
  }

  async status(): Promise<{ name: ChannelName; configured: boolean }[]> {
    const names = this.resolver ? ChannelHub.CHANNELS : [...this.adapters.keys()];
    return Promise.all(names.map(async (name) => ({ name, configured: (await this.adapterFor(name))?.isConfigured() ?? false })));
  }

  /** Acknowledge a Telegram inline-button tap (stops the client spinner). Best effort. */
  async acknowledgeTap(channel: ChannelName, tapId: string): Promise<void> {
    const adapter = await this.adapterFor(channel);
    if (!adapter?.isConfigured() || !(adapter instanceof TelegramAdapter)) return;
    await adapter.answerCallbackQuery(tapId);
  }

  /** Sends a rich reply rendered by the channel adapter (or numbered text), stored first so it can be retried. */
  async reply(channel: ChannelName, to: string, input: BotReply, notify?: NotifyOpts): Promise<void> {
    const reply = normaliseReply(input);
    await this.dispatch(channel, to, renderPlain(reply), { kind: 'reply', reply }, optionsOf(reply), notify);
  }

  async send(channel: ChannelName, to: string, text: string, notify?: NotifyOpts): Promise<void> {
    await this.dispatch(channel, to, text, { kind: 'text', text }, [], notify);
  }

  /** Sends a document (WhatsApp) stored first like every message; the text stand-in carries the link for logs and other channels. */
  async document(channel: ChannelName, to: string, doc: { url: string; filename: string; caption: string }, notify?: NotifyOpts): Promise<void> {
    await this.dispatch(channel, to, `${doc.caption}\n${doc.url}`, { kind: 'document', ...doc }, [], notify);
  }

  /** Template for an event from Settings, with parameters filled in the mapped order ('-' when a value is missing). */
  private async templateFor(event: NotificationEvent, params: Partial<Record<TemplateParam, string>>): Promise<TemplateMessage | null> {
    const mapping = (await this.getSettings?.())?.whatsappTemplates[event];
    return mapping ? { name: mapping.name, language: mapping.language, params: mapping.params.map((k) => templateText(params[k])) } : null;
  }

  /**
   * Outbox: store → try now. A retryable failure leaves the message `queued` for the worker (no error to the caller,
   * nothing is lost); a permanent failure marks it `failed` and is rethrown.
   */
  private async dispatch(channel: ChannelName, to: string, text: string, base: OutboundPayload, options: ReplyOption[] = [], notify?: NotifyOpts): Promise<void> {
    const adapter = await this.adapterFor(channel);
    if (!adapter) throw new ValidationError(`Unknown channel: ${channel}`);
    let payload: OutboundPayload = notify?.event ? { ...base, notify: { event: notify.event, params: notify.params ?? {} } } : base;
    // WhatsApp only allows free-form business messages within 24 h of the user's last message; otherwise a template is required.
    if (adapter.isConfigured() && channel === 'whatsapp' && notify?.event && !(await this.log.withinReplyWindow(channel, to))) {
      const tpl = await this.templateFor(notify.event, notify.params ?? {});
      if (!tpl) {
        await this.log.createOutbound({ channel, to, text, payload, options, status: 'failed',
          error: { code: 'NO_TEMPLATE', message: 'outside 24h window — no template configured' } });
        return;
      }
      payload = { kind: 'template', ...tpl, notify: payload.notify! };
    }
    const id = await this.log.createOutbound({ channel, to, text, payload, options, status: adapter.isConfigured() ? 'queued' : 'skipped' });
    if (!adapter.isConfigured()) return;
    await this.deliver(id, { immediate: true });
  }

  /** Sends a stored message if it is still `queued`. Used for the first attempt and by the `message.send` job. */
  async deliver(id: string, o: { immediate?: boolean; finalAttempt?: boolean } = {}): Promise<void> {
    const m = await this.log.getForDelivery(id);
    if (!m || m.status !== 'queued') return; // already sent, failed or gone: nothing to do (idempotent)
    const adapter = await this.adapterFor(m.channel);
    try {
      if (!adapter?.isConfigured()) throw new ChannelError(m.channel, 400, 'channel is not configured');
      const payload: OutboundPayload = m.payload ?? { kind: 'text', text: m.text };
      let providerId: string | void;
      try {
        providerId = await this.sendPayload(adapter, m.to, payload, m.text);
      } catch (err) {
        // 131047 = "re-engagement required": we thought we were inside the 24 h window but Meta disagrees → template, once.
        if (!(err instanceof ChannelError && err.providerCode === 131047 && payload.notify && payload.kind !== 'template')) throw err;
        const tpl = await this.templateFor(payload.notify.event, payload.notify.params);
        if (!tpl) throw err;
        const next: OutboundPayload = { kind: 'template', ...tpl, notify: payload.notify };
        await this.log.setPayload(id, next);
        providerId = await this.sendPayload(adapter, m.to, next, m.text);
      }
      await this.log.markSent(id, providerId ?? undefined);
    } catch (err) {
      const code = err instanceof ChannelError ? String(err.providerCode ?? err.status) : 'NETWORK';
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

  private async sendPayload(adapter: ChannelAdapter, to: string, payload: OutboundPayload, text: string): Promise<string | void> {
    if (payload.kind === 'template') {
      if (!adapter.sendTemplate) throw new ChannelError(adapter.name, 400, 'channel does not support templates');
      return adapter.sendTemplate(to, { name: payload.name, language: payload.language, params: payload.params });
    }
    if (payload.kind === 'document') {
      const { url, filename, caption } = payload;
      return adapter.sendDocument ? adapter.sendDocument(to, { url, filename, caption }) : adapter.send(to, `${caption}\n${url}`);
    }
    if (payload.kind === 'reply' && adapter.sendReply) return adapter.sendReply(to, payload.reply);
    return adapter.send(to, textOf(payload, text));
  }
}

function textOf(payload: OutboundPayload, fallback: string): string {
  return payload.kind === 'text' ? payload.text : fallback;
}

/**
 * WhatsApp template parameters may not contain newlines, tabs or 4+ consecutive spaces (error 132018) and are at most 1024
 * characters. Values such as a customer's profile name or a product name are user-controlled, so they are normalised here.
 */
export function templateText(value: string | undefined): string {
  const clean = (value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 1024).trim();
  return clean || '-';
}
