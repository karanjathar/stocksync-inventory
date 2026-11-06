import { z } from 'zod';
import type { InboundMessage } from '../domain/types.js';

// Schemas are deliberately permissive (unknown keys allowed); only the fields we use are checked.
const waValue = z.object({
  contacts: z.array(z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).optional() })).optional(),
  messages: z.array(z.object({
    id: z.string(),
    from: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    interactive: z.object({
      type: z.string(),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    }).optional(),
    button: z.object({ payload: z.string(), text: z.string() }).optional(),
  })).optional(),
});

const metaBody = z.object({
  object: z.string(),
  entry: z.array(z.object({
    changes: z.array(z.object({ value: z.unknown() })).optional(),
    messaging: z.array(z.unknown()).optional(),
  })),
});

const pageMessage = z.object({
  sender: z.object({ id: z.string() }),
  message: z.object({
    mid: z.string(),
    text: z.string().optional(),
    is_echo: z.boolean().optional(),
    quick_reply: z.object({ payload: z.string() }).optional(),
  }),
});
const pagePostback = z.object({
  sender: z.object({ id: z.string() }),
  timestamp: z.number().optional(),
  postback: z.object({ mid: z.string().optional(), title: z.string().optional(), payload: z.string() }),
});

type WaMessage = NonNullable<z.infer<typeof waValue>['messages']>[number];

/** Text + optional action for a WhatsApp message; undefined for unsupported types (media, flows…). */
function waContent(m: WaMessage): { text: string; action?: string } | undefined {
  if (m.type === 'text' && m.text) return { text: m.text.body };
  if (m.type === 'interactive') {
    const tap = m.interactive?.button_reply ?? m.interactive?.list_reply;
    return tap ? { text: tap.title, action: tap.id } : undefined;
  }
  if (m.type === 'button' && m.button) return { text: m.button.text, action: m.button.payload };
  return undefined;
}

/** Extracts text messages and taps from a Meta webhook (WhatsApp Business, Messenger page, Instagram). */
export function parseMetaWebhook(body: unknown): InboundMessage[] {
  const parsed = metaBody.safeParse(body);
  if (!parsed.success) return [];
  const out: InboundMessage[] = [];
  const { object, entry } = parsed.data;

  if (object === 'whatsapp_business_account') {
    for (const e of entry) {
      for (const change of e.changes ?? []) {
        const v = waValue.safeParse(change.value);
        if (!v.success) continue;
        for (const m of v.data.messages ?? []) {
          const content = waContent(m);
          if (!content) continue;
          const contact = v.data.contacts?.find((c) => c.wa_id === m.from) ?? v.data.contacts?.[0];
          const name = contact?.profile?.name;
          out.push({ channel: 'whatsapp', from: m.from, text: content.text, ...(content.action ? { action: content.action } : {}), externalId: m.id, ...(name ? { senderName: name } : {}) });
        }
      }
    }
  } else if (object === 'page' || object === 'instagram') {
    const channel = object === 'page' ? 'messenger' : 'instagram';
    for (const e of entry) {
      for (const raw of e.messaging ?? []) {
        const msg = pageMessage.safeParse(raw);
        if (msg.success) {
          const m = msg.data.message;
          if (m.is_echo || !m.text) continue;
          out.push({ channel, from: msg.data.sender.id, text: m.text, ...(m.quick_reply ? { action: m.quick_reply.payload } : {}), externalId: m.mid });
          continue;
        }
        const pb = pagePostback.safeParse(raw);
        if (pb.success) {
          const p = pb.data.postback;
          out.push({ channel, from: pb.data.sender.id, text: p.title ?? p.payload, action: p.payload,
            externalId: p.mid ?? `pb:${pb.data.sender.id}:${pb.data.timestamp ?? p.payload}` });
        }
      }
    }
  }
  return out;
}

const tgMessage = z.object({
  message: z.object({
    message_id: z.number(),
    chat: z.object({ id: z.union([z.number(), z.string()]) }),
    from: z.object({ first_name: z.string().optional() }).optional(),
    text: z.string(),
  }),
});
const tgCallback = z.object({
  callback_query: z.object({
    id: z.string(),
    data: z.string(),
    from: z.object({ first_name: z.string().optional() }).optional(),
    message: z.object({ chat: z.object({ id: z.union([z.number(), z.string()]) }) }),
  }),
});

export function parseTelegramUpdate(body: unknown): InboundMessage | undefined {
  const cb = tgCallback.safeParse(body);
  if (cb.success) {
    const q = cb.data.callback_query;
    const name = q.from?.first_name;
    return { channel: 'telegram', from: String(q.message.chat.id), text: q.data, action: q.data, externalId: `tgcb:${q.id}`, ...(name ? { senderName: name } : {}) };
  }
  const u = tgMessage.safeParse(body);
  if (!u.success) return undefined;
  const m = u.data.message;
  const chatId = String(m.chat.id);
  const name = m.from?.first_name;
  return { channel: 'telegram', from: chatId, text: m.text, externalId: `tg:${chatId}:${m.message_id}`, ...(name ? { senderName: name } : {}) };
}

/** The callback_query id of a Telegram inline-button tap (must be answered), if any. */
export function telegramCallbackId(body: unknown): string | undefined {
  const cb = tgCallback.safeParse(body);
  return cb.success ? cb.data.callback_query.id : undefined;
}
