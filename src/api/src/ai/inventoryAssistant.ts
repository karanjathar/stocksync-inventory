import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import type { ProductsRepo } from '../repositories/products.js';
import type { OrdersService } from '../services/orders.js';
import type { ReorderService } from '../services/reorder.js';
import type { SettingsService } from '../services/settings.js';
import { formatMoney } from '../services/money.js';
import type { AiGateway } from './gateway.js';
import type { AiBlock, AiMessage, AiTool } from './client.js';
import { definePrompt, leaksPrompt, UNTRUSTED_INPUT_RULES } from './prompts.js';

export const ASSISTANT_PROMPT = definePrompt('inventory-assistant', 1, `You are the inventory assistant inside a shop-management app. You answer questions from the shop's own staff about their stock, sales, reorders and orders. Answer in the language the user writes in (English, Hindi or Hinglish), briefly.

${UNTRUSTED_INPUT_RULES}

Rules:
- Use the tools to get facts. Quote figures only exactly as the tools returned them; never estimate, round differently or invent numbers, products or orders. If the tools do not give the answer, say so.
- You can only READ. You cannot change stock, prices, orders, refunds or settings, and you cannot see other shops. If asked to change something, say you cannot and name the page of the app where it is done (Inventory, Products, Orders, Purchasing).
- Keep answers short: the answer first, then at most a few supporting numbers.`);

export interface Figure { tool: string; input: Record<string, unknown>; result: unknown }
export interface Answer { answer: string; figures: Figure[] }
export interface Turn { role: 'user' | 'assistant'; content: string }

const MAX_STEPS = 6;
const TOOLS: AiTool[] = [
  { name: 'stock_levels', description: 'Look up products and how many are in stock, by words from the sku or name (omit query to list a few).',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false } },
  { name: 'low_stock', description: 'Products at or below their reorder level.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sales_summary', description: 'Orders and revenue per day for the last N days (cancelled orders excluded), with totals.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90 } }, required: ['days'], additionalProperties: false } },
  { name: 'top_products', description: 'Best-selling products by units sold in the last N days (cancelled orders excluded).',
    input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['days'], additionalProperties: false } },
  { name: 'reorder_suggestions', description: 'What to reorder now (low products minus what is already on open purchase orders), with suggested quantities.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'find_order', description: 'One order by its number: status, payment, items and total.',
    input_schema: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: false } },
];
const s = {
  stock: z.object({ query: z.string().max(100).optional(), limit: z.number().int().min(1).max(20).optional() }).strict(),
  none: z.object({}).strict(),
  sales: z.object({ days: z.number().int().min(1).max(90) }).strict(),
  top: z.object({ days: z.number().int().min(1).max(90), limit: z.number().int().min(1).max(10).optional() }).strict(),
  order: z.object({ number: z.number().int().min(1).max(2_000_000_000) }).strict(),
};

/**
 * A read-only question-and-answer helper for signed-in staff. Its tools only SELECT, run inside the caller's business (row-level security), and
 * take no ids, so they cannot reach another business or change anything. Every tool result is kept and returned with the answer, so the screen
 * can show the figures the answer was built from.
 */
export class InventoryAssistant {
  constructor(private readonly gateway: AiGateway, private readonly db: Queryable, private readonly products: ProductsRepo, private readonly reorder: ReorderService,
    private readonly orders: OrdersService, private readonly settings: SettingsService) {}

  available(): Promise<boolean> { return this.gateway.available(); }

  async ask(question: string, history: Turn[] = []): Promise<Answer> {
    const currency = (await this.settings.get()).currency;
    const money = (c: number) => formatMoney(c, currency);
    const messages: AiMessage[] = [
      ...history.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 600) })),
      { role: 'user', content: question.slice(0, 1000) },
    ];
    const figures: Figure[] = [];
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await this.gateway.run({ prompt: ASSISTANT_PROMPT, messages, tools: TOOLS, maxTokens: 600 });
      if (!res.toolUses.length) return { answer: res.text.trim() && !leaksPrompt(res.text, ASSISTANT_PROMPT) ? res.text.trim() : 'I could not work that out. Please try asking another way.', figures };
      messages.push({ role: 'assistant', content: res.content as AiBlock[] });
      const results: AiBlock[] = [];
      for (const use of res.toolUses) {
        const out = await this.tool(use.name, use.input, money);
        if (!out.error) figures.push({ tool: use.name, input: use.input, result: out.result });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: out.error ? out.error : JSON.stringify(out.result), ...(out.error ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { answer: 'That needed more steps than I can take in one go. Please ask a narrower question.', figures };
  }

  private async tool(name: string, input: Record<string, unknown>, money: (c: number) => string): Promise<{ result?: unknown; error?: string }> {
    const bad = { error: 'invalid arguments' };
    switch (name) {
      case 'stock_levels': {
        const a = s.stock.safeParse(input); if (!a.success) return bad;
        const list = await this.products.list({ ...(a.data.query ? { search: a.data.query } : {}), activeOnly: true, limit: a.data.limit ?? 10 });
        return { result: list.map((p) => ({ sku: p.sku, name: p.name, inStock: p.totalQuantity, unit: p.unit, reorderLevel: p.reorderLevel, price: money(p.priceCents) })) };
      }
      case 'low_stock': {
        if (!s.none.safeParse(input).success) return bad;
        const list = await this.products.list({ lowStock: true, activeOnly: true, limit: 25 });
        return { result: list.map((p) => ({ sku: p.sku, name: p.name, inStock: p.totalQuantity, reorderLevel: p.reorderLevel })) };
      }
      case 'sales_summary': {
        const a = s.sales.safeParse(input); if (!a.success) return bad;
        const days = (await this.db.query<{ day: string; orders: number; cents: number }>(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS orders, COALESCE(sum(total_cents), 0)::bigint AS cents FROM orders
           WHERE status <> 'CANCELLED' AND created_at >= date_trunc('day', now()) - make_interval(days => $1 - 1) GROUP BY 1 ORDER BY 1`, [a.data.days])).rows;
        const totalOrders = days.reduce((n, d) => n + d.orders, 0); const totalCents = days.reduce((n, d) => n + Number(d.cents), 0);
        return { result: { days: days.map((d) => ({ day: d.day, orders: d.orders, revenue: money(Number(d.cents)) })), totalOrders, totalRevenue: money(totalCents) } };
      }
      case 'top_products': {
        const a = s.top.safeParse(input); if (!a.success) return bad;
        const rows = (await this.db.query<{ sku: string; name: string; units: number; cents: number }>(
          `SELECT p.sku, p.name, sum(i.quantity)::int AS units, sum(i.quantity::bigint * i.unit_price_cents)::bigint AS cents FROM order_items i
           JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
           WHERE o.status <> 'CANCELLED' AND o.created_at >= date_trunc('day', now()) - make_interval(days => $1 - 1)
           GROUP BY p.sku, p.name ORDER BY units DESC, p.sku LIMIT $2`, [a.data.days, a.data.limit ?? 5])).rows;
        return { result: rows.map((r) => ({ sku: r.sku, name: r.name, unitsSold: r.units, revenue: money(Number(r.cents)) })) };
      }
      case 'reorder_suggestions': {
        if (!s.none.safeParse(input).success) return bad;
        const list = (await this.reorder.suggestions()).slice(0, 25);
        return { result: list.map((r) => ({ sku: r.sku, name: r.name, inStock: r.totalQuantity, reorderLevel: r.reorderLevel, onOrder: r.onOrderQuantity, suggestedQuantity: r.suggestedQuantity, supplier: r.supplierName })) };
      }
      case 'find_order': {
        const a = s.order.safeParse(input); if (!a.success) return bad;
        const o = await this.orders.getByNumber(a.data.number);
        if (!o) return { error: 'no such order' };
        return { result: { number: o.number, status: o.status, paymentStatus: o.paymentStatus, channel: o.channel, createdAt: o.createdAt, items: o.items.map((i) => ({ name: i.name, quantity: i.quantity })), total: money(o.totalCents) } };
      }
      default: return { error: 'unknown tool' };
    }
  }
}
