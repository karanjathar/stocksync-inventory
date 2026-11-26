import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { ValidationError } from '../domain/errors.js';

/** Dates are UTC calendar days, both ends inclusive. The range is validated here so no query ever runs unbounded. */
export const MAX_RANGE_DAYS = 366;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'not a real date');
export const rangeSchema = z.object({ from: day.optional(), to: day.optional() }).strict();
export const deadStockSchema = z.object({ days: z.coerce.number().int().min(7).max(730).default(60) }).strict();
export const productSalesSchema = z.object({ from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(100).default(10) }).strict();

export interface Range { from: string; to: string }
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Defaults to the last 30 days; rejects reversed or oversized ranges. */
export function resolveRange(q: { from?: string | undefined; to?: string | undefined }, today = new Date()): Range {
  const to = q.to ?? iso(today);
  const from = q.from ?? iso(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000));
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (span < 1) throw new ValidationError('Invalid request', [{ path: 'from', message: 'must not be after "to"' }]);
  if (span > MAX_RANGE_DAYS) throw new ValidationError('Invalid request', [{ path: 'from', message: `the range may span at most ${MAX_RANGE_DAYS} days` }]);
  return { from, to };
}

const CHAT_CHANNELS = ['whatsapp', 'messenger', 'instagram', 'telegram'];
const IN_RANGE = (col: string) => `(${col} AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date`;

export interface SalesDay { day: string; orders: number; units: number; revenueCents: number }
export interface SalesChannel { channel: string; orders: number; revenueCents: number }
export interface SalesProduct { sku: string; name: string; units: number; revenueCents: number }
export interface DeadStock { sku: string; name: string; inStock: number; stockValueCents: number; lastSoldAt: string | null; daysSinceSold: number | null }
export interface Margin { sku: string; name: string; units: number; revenueCents: number; unitCostCents: number | null; costCents: number | null; marginCents: number | null; marginPct: number | null }
export interface Funnel { conversations: number; orders: number; confirmed: number; paid: number; rates: { conversationToOrder: number | null; orderToConfirmed: number | null; confirmedToPaid: number | null } }

/** Read-only business analytics. Every query runs in the signed-in business's context (row-level security) and is bounded by a validated date range. Cancelled orders never count. */
export class AnalyticsService {
  constructor(private readonly db: Queryable) {}

  async salesByDay(r: Range): Promise<{ days: SalesDay[]; totals: { orders: number; units: number; revenueCents: number } }> {
    const { rows } = await this.db.query<SalesDay>(
      `WITH d AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day),
            o AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS orders, COALESCE(sum(total_cents), 0)::bigint AS rev FROM orders
                  WHERE status <> 'CANCELLED' AND ${IN_RANGE('created_at')} GROUP BY 1),
            u AS (SELECT (o.created_at AT TIME ZONE 'UTC')::date AS day, sum(i.quantity)::int AS units FROM order_items i JOIN orders o ON o.id = i.order_id
                  WHERE o.status <> 'CANCELLED' AND ${IN_RANGE('o.created_at')} GROUP BY 1)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(o.orders, 0) AS orders, COALESCE(u.units, 0) AS units, COALESCE(o.rev, 0)::bigint AS "revenueCents"
       FROM d LEFT JOIN o ON o.day = d.day LEFT JOIN u ON u.day = d.day ORDER BY d.day`, [r.from, r.to]);
    const days = rows.map((x) => ({ ...x, revenueCents: Number(x.revenueCents) }));
    return { days, totals: { orders: days.reduce((a, x) => a + x.orders, 0), units: days.reduce((a, x) => a + x.units, 0), revenueCents: days.reduce((a, x) => a + x.revenueCents, 0) } };
  }

  async salesByChannel(r: Range): Promise<SalesChannel[]> {
    const { rows } = await this.db.query<SalesChannel>(
      `SELECT channel, count(*)::int AS orders, COALESCE(sum(total_cents), 0)::bigint AS "revenueCents" FROM orders
       WHERE status <> 'CANCELLED' AND ${IN_RANGE('created_at')} GROUP BY channel ORDER BY 3 DESC, channel`, [r.from, r.to]);
    return rows.map((x) => ({ ...x, revenueCents: Number(x.revenueCents) }));
  }

  async salesByProduct(r: Range, limit: number): Promise<SalesProduct[]> {
    const { rows } = await this.db.query<SalesProduct>(
      `SELECT p.sku, p.name, sum(i.quantity)::int AS units, sum(i.quantity::bigint * i.unit_price_cents)::bigint AS "revenueCents"
       FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
       WHERE o.status <> 'CANCELLED' AND ${IN_RANGE('o.created_at')} GROUP BY p.id, p.sku, p.name ORDER BY 4 DESC, 3 DESC, p.sku LIMIT $3`, [r.from, r.to, limit]);
    return rows.map((x) => ({ ...x, revenueCents: Number(x.revenueCents) }));
  }

  /** Products in stock that have not left it (an OUT movement) for `days` days, oldest first. New products are not flagged. */
  async deadStock(days: number): Promise<DeadStock[]> {
    const { rows } = await this.db.query<DeadStock>(
      `SELECT p.sku, p.name, s.qty AS "inStock", (s.qty::bigint * p.price_cents)::bigint AS "stockValueCents", m.last AS "lastSoldAt",
              CASE WHEN m.last IS NULL THEN NULL ELSE floor(extract(epoch FROM now() - m.last) / 86400)::int END AS "daysSinceSold"
       FROM products p
       CROSS JOIN LATERAL (SELECT COALESCE(sum(quantity), 0)::int AS qty FROM stock_levels WHERE product_id = p.id) s
       LEFT JOIN LATERAL (SELECT max(created_at) AS last FROM stock_movements WHERE product_id = p.id AND type = 'OUT') m ON true
       WHERE p.is_active AND s.qty > 0 AND p.created_at < now() - make_interval(days => $1) AND (m.last IS NULL OR m.last < now() - make_interval(days => $1))
       ORDER BY m.last NULLS FIRST, "stockValueCents" DESC, p.sku LIMIT 200`, [days]);
    return rows.map((x) => ({ ...x, stockValueCents: Number(x.stockValueCents) }));
  }

  /** Revenue minus units × the latest cost actually paid to a supplier (the newest purchase order line with units received). No cost yet: margin unknown, never guessed. */
  async margins(r: Range, limit: number): Promise<{ products: Margin[]; totals: { revenueCents: number; costCents: number; marginCents: number; marginPct: number | null; unknownCostProducts: number } }> {
    const { rows } = await this.db.query<Margin>(
      `SELECT p.sku, p.name, sum(i.quantity)::int AS units, sum(i.quantity::bigint * i.unit_price_cents)::bigint AS "revenueCents", c.cost AS "unitCostCents"
       FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
       LEFT JOIN LATERAL (SELECT l.unit_cost_cents AS cost FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
                          WHERE l.product_id = p.id AND po.status <> 'CANCELLED' AND l.received_quantity > 0 ORDER BY po.created_at DESC, po.number DESC LIMIT 1) c ON true
       WHERE o.status <> 'CANCELLED' AND ${IN_RANGE('o.created_at')} GROUP BY p.id, p.sku, p.name, c.cost ORDER BY 4 DESC, p.sku`, [r.from, r.to]);
    const products: Margin[] = rows.map((x) => {
      const revenueCents = Number(x.revenueCents); const unit = x.unitCostCents === null ? null : Number(x.unitCostCents);
      const costCents = unit === null ? null : unit * x.units;
      const marginCents = costCents === null ? null : revenueCents - costCents;
      return { sku: x.sku, name: x.name, units: x.units, revenueCents, unitCostCents: unit, costCents, marginCents, marginPct: marginCents === null || revenueCents === 0 ? null : Math.round((marginCents / revenueCents) * 1000) / 10 };
    });
    const known = products.filter((p) => p.marginCents !== null);
    const revenueCents = known.reduce((a, p) => a + p.revenueCents, 0); const costCents = known.reduce((a, p) => a + (p.costCents ?? 0), 0);
    return { products: products.slice(0, limit), totals: { revenueCents, costCents, marginCents: revenueCents - costCents, marginPct: revenueCents ? Math.round(((revenueCents - costCents) / revenueCents) * 1000) / 10 : null,
      unknownCostProducts: products.length - known.length } };
  }

  /** From chat to money: people who wrote in, orders made from chat channels, orders confirmed or fulfilled, orders paid online. */
  async funnel(r: Range): Promise<Funnel> {
    const row = (await this.db.query<{ conversations: number; orders: number; confirmed: number; paid: number }>(
      `SELECT (SELECT count(DISTINCT (channel, external_user)) FROM channel_messages WHERE direction = 'in' AND ${IN_RANGE('created_at')})::int AS conversations,
              count(*) FILTER (WHERE status <> 'CANCELLED')::int AS orders,
              count(*) FILTER (WHERE status IN ('CONFIRMED', 'FULFILLED'))::int AS confirmed,
              count(*) FILTER (WHERE payment_status = 'PAID')::int AS paid
       FROM orders WHERE channel = ANY($3::text[]) AND ${IN_RANGE('created_at')}`, [r.from, r.to, CHAT_CHANNELS])).rows[0]!;
    const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
    return { ...row, rates: { conversationToOrder: rate(row.orders, row.conversations), orderToConfirmed: rate(row.confirmed, row.orders), confirmedToPaid: rate(row.paid, row.confirmed) } };
  }
}
