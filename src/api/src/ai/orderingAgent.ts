import type { Logger } from 'pino';
import { z } from 'zod';
import type { BotReply } from '../channels/reply.js';
import { LIMITS, truncate } from '../channels/reply.js';
import type { Queryable } from '../db/pool.js';
import { AppError } from '../domain/errors.js';
import type { InboundMessage } from '../domain/types.js';
import type { CustomersRepo } from '../repositories/customers.js';
import type { ChatCartsRepo } from '../repositories/chatCarts.js';
import type { ProductsRepo } from '../repositories/products.js';
import type { ChatFlow } from '../services/chatFlow.js';
import { formatMoney } from '../services/money.js';
import type { SettingsService } from '../services/settings.js';
import type { AiGateway } from './gateway.js';
import type { AiBlock, AiMessage, AiTool } from './client.js';
import { definePrompt, leaksPrompt, UNTRUSTED_INPUT_RULES } from './prompts.js';

/** Version 1 of the ordering prompt. A change is a new version; the customer's words are never part of it. */
export const ORDER_AGENT_PROMPT = definePrompt('order-agent', 1, `You help customers of an online shop order from its chat. The customer may write English, Hindi (Devanagari) or Hinglish (Hindi in Latin letters); always answer in the customer's own language and style, in one or two short sentences.

${UNTRUSTED_INPUT_RULES}

How to work:
- Use search_products to find items. Match the customer's words to products by meaning (for example "doodh" is milk, "do kilo" is 2 kg). Never invent products, prices or stock: only say what the tools returned.
- When one product clearly matches, call add_to_cart with its sku and the quantity the customer asked for.
- When several products could match, or the quantity is unclear, do NOT guess: call offer_choices with the candidate skus so the customer can tap the one they mean.
- show_cart reads the customer's cart.
- When the customer wants to pay or finish, call checkout. It only shows the customer a confirmation button; an order is never placed by you and never without the customer tapping that button. Never say an order has been placed.
- If the message is not about shopping, or you cannot help, say so briefly and suggest typing "menu".`);

const MAX_STEPS = 5;
const MAX_TEXT = 500;
const HISTORY = 6;
const HISTORY_TEXT = 300;

const TOOLS: AiTool[] = [
  { name: 'search_products', description: 'Search this shop\'s in-stock products by words from the customer (any language). Returns at most 8 matches with sku, name, price, unit and available quantity.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'search words, e.g. "milk" or "t-shirt"' } }, required: ['query'], additionalProperties: false } },
  { name: 'add_to_cart', description: 'Add a product to THIS customer\'s cart by sku. Quantity is capped at the available stock.',
    input_schema: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['sku', 'quantity'], additionalProperties: false } },
  { name: 'show_cart', description: 'Read THIS customer\'s cart.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'offer_choices', description: 'The request is ambiguous: show the customer a tap list of 2 to 8 candidate products (by sku) instead of guessing. Ends your turn.',
    input_schema: { type: 'object', properties: { skus: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8 } }, required: ['skus'], additionalProperties: false } },
  { name: 'checkout', description: 'The customer is ready to pay. Shows them their cart with payment buttons; nothing is ordered until they tap one. Ends your turn.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];

const addSchema = z.object({ sku: z.string().min(1).max(64), quantity: z.number().int().min(1).max(100) }).strict();
const searchSchema = z.object({ query: z.string().min(1).max(100) }).strict();
const choicesSchema = z.object({ skus: z.array(z.string().min(1).max(64)).min(2).max(8) }).strict();
const noArgs = z.object({}).strict();

type Outcome = { result: string; error?: boolean; end?: BotReply };

/**
 * Turns a free-text chat message into cart changes with a tool-using model. The model can only call five tools; every tool is bound by THIS code to the
 * sender's own customer record and this shop's catalogue (the model supplies sku and quantity, never an id of a customer, a price or a shop), the model
 * has no way to place an order (checkout only shows the existing confirmation buttons), and anything wrong with the AI (off, over budget, failing,
 * confused) ends in `undefined`, so the caller shows the normal tap menu instead.
 */
export class OrderingAgent {
  constructor(private readonly gateway: AiGateway, private readonly products: ProductsRepo, private readonly carts: ChatCartsRepo, private readonly customers: CustomersRepo,
    private readonly flow: ChatFlow, private readonly settings: SettingsService, private readonly db: Queryable, private readonly logger: Logger) {}

  async handle(msg: InboundMessage): Promise<BotReply | undefined> {
    const text = msg.text.trim();
    if (!text || msg.action !== undefined) return undefined;
    try {
      if (!(await this.gateway.available())) return undefined;
      const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName); // who is asking comes from the channel, never from the model
      const currency = (await this.settings.get()).currency;
      const fmt = (c: number) => formatMoney(c, currency);
      const messages: AiMessage[] = [...(await this.history(msg, text)), { role: 'user', content: text.slice(0, MAX_TEXT) }];

      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await this.gateway.run({ prompt: ORDER_AGENT_PROMPT, messages, tools: TOOLS, maxTokens: 400 });
        if (!res.toolUses.length) return leaksPrompt(res.text, ORDER_AGENT_PROMPT) ? undefined : this.finish(res.text, customer.id);
        messages.push({ role: 'assistant', content: res.content as AiBlock[] });
        const results: AiBlock[] = [];
        let end: BotReply | undefined;
        for (const use of res.toolUses) {
          const out = await this.runTool(use.name, use.input, customer.id, msg, fmt);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: out.result, ...(out.error ? { is_error: true } : {}) });
          if (out.end) end = out.end;
        }
        if (end) return end;
        messages.push({ role: 'user', content: results });
      }
      return undefined; // it kept calling tools without finishing: the menu is better than a half-done answer
    } catch (err) {
      this.logger.info({ ai: { agent: ORDER_AGENT_PROMPT.ref, fallback: err instanceof AppError || err instanceof Error ? (err as { code?: string }).code ?? 'error' : 'error' } }, 'ai ordering fell back to the menu');
      return undefined;
    }
  }

  private async runTool(name: string, input: Record<string, unknown>, customerId: string, msg: InboundMessage, fmt: (c: number) => string): Promise<Outcome> {
    const bad = (m: string): Outcome => ({ result: m, error: true });
    switch (name) {
      case 'search_products': {
        const a = searchSchema.safeParse(input); if (!a.success) return bad('invalid arguments');
        const found = (await this.products.list({ search: a.data.query, activeOnly: true, limit: 50 })).filter((p) => p.totalQuantity > 0).slice(0, 8);
        return { result: JSON.stringify(found.map((p) => ({ sku: p.sku, name: p.name, price: fmt(p.priceCents), unit: p.unit, available: p.totalQuantity }))) };
      }
      case 'add_to_cart': {
        const a = addSchema.safeParse(input); if (!a.success) return bad('invalid arguments');
        const p = await this.products.getBySku(a.data.sku);
        if (!p || !p.isActive || p.totalQuantity <= 0) return bad('no such product in stock');
        const { added, capped } = await this.carts.add(customerId, p.id, a.data.quantity);
        return { result: JSON.stringify({ added, capped, product: p.name, available: p.totalQuantity }) };
      }
      case 'show_cart': {
        if (!noArgs.safeParse(input).success) return bad('invalid arguments');
        const cart = await this.carts.get(customerId);
        return { result: JSON.stringify({ lines: cart.lines.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity, lineTotal: fmt(l.quantity * l.unitPriceCents) })), total: fmt(cart.totalCents) }) };
      }
      case 'offer_choices': {
        const a = choicesSchema.safeParse(input); if (!a.success) return bad('invalid arguments');
        const rows = [];
        for (const sku of [...new Set(a.data.skus)]) {
          const p = await this.products.getBySku(sku);
          if (p?.isActive && p.totalQuantity > 0) rows.push({ id: `prod:${p.id}`, title: truncate(p.name, LIMITS.rowTitle), description: truncate(fmt(p.priceCents), LIMITS.rowDescription) });
        }
        if (rows.length < 2) return bad('fewer than two of those products are in stock; search again');
        return { result: 'A tap list was shown to the customer.', end: { text: 'Which one do you mean? Tap to choose 👇', list: { button: 'Choose', sections: [{ title: 'Options', rows }] } } };
      }
      case 'checkout': {
        if (!noArgs.safeParse(input).success) return bad('invalid arguments');
        const reply = await this.flow.handle({ ...msg, action: 'checkout' }); // the normal checkout screen: payment buttons only, nothing ordered
        return reply ? { result: 'The customer was shown their cart and payment buttons.', end: reply } : bad('checkout is not available');
      }
      default:
        return bad('unknown tool'); // the model asked for something that does not exist (for example place_order): nothing happens
    }
  }

  /** The model's closing words, plus the shortcuts a customer needs next. */
  private async finish(text: string, customerId: string): Promise<BotReply | undefined> {
    const said = truncate(text, LIMITS.text);
    if (!said) return undefined;
    const cart = await this.carts.get(customerId);
    const buttons = cart.lines.length
      ? [{ id: 'checkout', title: '🧾 Checkout' }, { id: 'cart', title: '🛒 My cart' }, { id: 'catalog', title: '🛍 Browse' }]
      : [{ id: 'catalog', title: '🛍 Browse' }, { id: 'menu', title: '🏠 Menu' }];
    return { text: said, buttons };
  }

  /** The last few messages with this person, as plain turns, so "yes, two of those" makes sense. Our own words are replayed as the assistant's. */
  private async history(msg: InboundMessage, current: string): Promise<AiMessage[]> {
    const rows = (await this.db.query<{ direction: string; text: string }>(
      'SELECT direction, text FROM channel_messages WHERE channel = $1 AND external_user = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [msg.channel, msg.from, HISTORY + 1])).rows.reverse();
    if (rows.at(-1)?.direction === 'in' && rows.at(-1)?.text.trim() === current) rows.pop(); // the message being handled was stored just before
    const turns: AiMessage[] = rows.map((r) => ({ role: r.direction === 'in' ? 'user' as const : 'assistant' as const, content: r.text.slice(0, HISTORY_TEXT) }));
    while (turns[0]?.role === 'assistant') turns.shift();
    return turns;
  }
}
