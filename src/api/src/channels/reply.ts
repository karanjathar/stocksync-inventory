/**
 * Channel-neutral rich reply (docs/3_SCHEMAS.md §3.8). The bot builds one BotReply; each channel
 * adapter renders it within its platform limits, or falls back to numbered text via renderPlain().
 */

export interface ReplyButton { id: string; title: string }
export interface ReplyListRow { id: string; title: string; description?: string }
export interface ReplyListSection { title: string; rows: ReplyListRow[] }
export interface BotReply {
  text: string;
  buttons?: ReplyButton[];
  list?: { button: string; sections: ReplyListSection[] };
  link?: { label: string; url: string };
}
export interface ReplyOption { id: string; title: string }

/** WhatsApp Cloud API interactive limits (the strictest common denominator) + Telegram callback_data bytes. */
export const LIMITS = {
  text: 1024,
  plainText: 4096,
  buttons: 3,
  buttonTitle: 20,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  actionBytes: 64,
} as const;

/**
 * Shortens to at most `max` UTF-16 units without ever splitting a code point (emoji, CJK supplementary chars):
 * Meta doesn't specify how emoji count, so we satisfy the stricter UTF-16 interpretation.
 */
export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  let out = '';
  for (const cp of clean) {
    if (out.length + cp.length > max - 1) break;
    out += cp;
  }
  return `${out.trimEnd()}…`;
}

const validId = (id: string) => id.length > 0 && Buffer.byteLength(id, 'utf8') <= LIMITS.actionBytes;

/** Clamps a reply to platform limits. Never throws: overflow is truncated or dropped. */
export function normaliseReply(reply: BotReply): BotReply {
  const buttons = (reply.buttons ?? [])
    .filter((b) => validId(b.id))
    .slice(0, LIMITS.buttons)
    .map((b) => ({ id: b.id, title: truncate(b.title, LIMITS.buttonTitle) }));

  let remaining: number = LIMITS.rows;
  const sections: ReplyListSection[] = [];
  for (const s of reply.list?.sections ?? []) {
    if (remaining <= 0) break;
    const rows = s.rows.filter((r) => validId(r.id)).slice(0, remaining).map((r) => ({
      id: r.id,
      title: truncate(r.title, LIMITS.rowTitle),
      ...(r.description ? { description: truncate(r.description, LIMITS.rowDescription) } : {}),
    }));
    if (!rows.length) continue;
    remaining -= rows.length;
    sections.push({ title: truncate(s.title, LIMITS.sectionTitle), rows });
  }

  const out: BotReply = { text: reply.text };
  if (buttons.length) out.buttons = buttons;
  else if (sections.length && reply.list) out.list = { button: truncate(reply.list.button, LIMITS.buttonTitle), sections };
  else if (reply.link?.url) out.link = { label: truncate(reply.link.label, LIMITS.buttonTitle), url: reply.link.url };

  const interactive = Boolean(out.buttons || out.list || out.link);
  out.text = truncate(reply.text, interactive ? LIMITS.text : LIMITS.plainText) || '…';
  return out;
}

/** The selectable options of a reply, in display order. */
export function optionsOf(reply: BotReply): ReplyOption[] {
  if (reply.buttons?.length) return reply.buttons.map((b) => ({ id: b.id, title: b.title }));
  if (reply.list) return reply.list.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })));
  return [];
}

/** Text rendering for channels without rich UI: numbered options + link. */
export function renderPlain(reply: BotReply): string {
  const parts = [reply.text];
  if (reply.buttons?.length) {
    parts.push(reply.buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n'), 'Reply with a number.');
  } else if (reply.list) {
    const rows = reply.list.sections.flatMap((s) => s.rows);
    parts.push(rows.map((r, i) => `${i + 1}. ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n'), 'Reply with a number.');
  }
  if (reply.link) parts.push(`${reply.link.label}: ${reply.link.url}`);
  return parts.join('\n\n');
}

/** Maps a reply like "2" to the id of the 2nd option last shown to the user. */
export function resolveNumberedChoice(text: string, options: ReplyOption[]): string | undefined {
  const m = /^\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return undefined;
  return options[Number(m[1]) - 1]?.id;
}
