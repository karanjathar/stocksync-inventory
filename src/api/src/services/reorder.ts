import type pg from 'pg';
import { ConflictError } from '../domain/errors.js';
import type { PurchaseOrder } from '../domain/types.js';
import type { PurchaseOrdersService } from './purchaseOrders.js';
import type { SettingsService } from './settings.js';
import { enoughHistory, forecastDaily, sum, trimLeadingZeros } from './forecast.js';

export interface ReorderSuggestion {
  productId: string; sku: string; name: string; unit: string; totalQuantity: number; reorderLevel: number;
  onOrderQuantity: number; suggestedQuantity: number; supplierId: string | null; supplierName: string | null; unitCostCents: number;
  /** `forecast`: sized from expected demand over the supplier's lead time; `rules`: the plain "refill to twice the reorder level" rule (not enough history). */
  basis: 'forecast' | 'rules';
  leadTimeDays: number;
  /** Expected units sold over lead time plus review period (forecast basis only). */
  forecastUnits: number | null;
}

const LOCK_KEY = 727275;
const DEFAULT_LEAD_DAYS = 7;
const REVIEW_DAYS = 7;       // how long one order should last beyond its delivery
const HISTORY_DAYS = 90;

/**
 * Reorder suggestions. With enough sales history (about four weeks) a product is sized from forecast demand over the supplier's lead time plus a
 * review period, keeping its reorder level as safety stock, minus what is already on open purchase orders. Without enough history the original rule
 * applies: low products refill to twice the reorder level.
 */
export class ReorderService {
  constructor(private readonly pool: pg.Pool, private readonly orders: PurchaseOrdersService, private readonly settings: SettingsService) {}

  async suggestions(only?: string[]): Promise<ReorderSuggestion[]> {
    const { rows } = await this.pool.query<Omit<ReorderSuggestion, 'basis' | 'forecastUnits'> & { rule: number }>(
      `SELECT p.id AS "productId", p.sku, p.name, p.unit, p.reorder_level AS "reorderLevel", t.total AS "totalQuantity",
              COALESCE(oo.qty, 0) AS "onOrderQuantity", GREATEST(p.reorder_level * 2 - t.total - COALESCE(oo.qty, 0), 0) AS rule,
              last.supplier_id AS "supplierId", s.name AS "supplierName", COALESCE(last.cost, 0) AS "unitCostCents", COALESCE(s.lead_time_days, ${DEFAULT_LEAD_DAYS}) AS "leadTimeDays"
       FROM products p
       CROSS JOIN LATERAL (SELECT COALESCE(sum(quantity), 0)::int AS total FROM stock_levels WHERE product_id = p.id) t
       LEFT JOIN LATERAL (SELECT sum(l.quantity - l.received_quantity)::int AS qty FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
                          WHERE l.product_id = p.id AND po.status IN ('DRAFT','SENT','PARTIALLY_RECEIVED')) oo ON true
       LEFT JOIN LATERAL (SELECT po.supplier_id, l.unit_cost_cents AS cost FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
                          WHERE l.product_id = p.id AND po.status <> 'CANCELLED' ORDER BY po.created_at DESC, po.number DESC LIMIT 1) last ON true
       LEFT JOIN suppliers s ON s.id = last.supplier_id
       WHERE p.is_active AND p.reorder_level > 0 AND ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))
       ORDER BY p.sku`, [only ?? null]);
    const history = await this.history(rows.map((r) => r.productId));
    const out: ReorderSuggestion[] = [];
    for (const { rule, ...r } of rows) {
      const past = history.series.get(r.productId);
      const trimmed = past ? trimLeadingZeros(past, history.startDow) : undefined;
      if (trimmed && enoughHistory(trimmed.series)) {
        const cover = r.leadTimeDays + REVIEW_DAYS;
        const expected = sum(forecastDaily(trimmed.series, trimmed.startDow, cover));
        const suggestedQuantity = Math.max(0, Math.ceil(expected) + r.reorderLevel - r.totalQuantity - r.onOrderQuantity);
        if (suggestedQuantity > 0) out.push({ ...r, suggestedQuantity, basis: 'forecast', forecastUnits: Math.round(expected * 10) / 10 });
      } else if (r.totalQuantity <= r.reorderLevel && rule > 0) {
        out.push({ ...r, suggestedQuantity: rule, basis: 'rules', forecastUnits: null });
      }
    }
    return out;
  }

  /** Units sold per day for the last 90 complete days (UTC), cancelled orders excluded, for each product that sold anything. */
  private async history(productIds: string[]): Promise<{ series: Map<string, number[]>; startDow: number }> {
    const end = new Date(); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() - 1);          // yesterday: today is incomplete
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - (HISTORY_DAYS - 1));
    const series = new Map<string, number[]>();
    if (!productIds.length) return { series, startDow: start.getUTCDay() };
    const { rows } = await this.pool.query<{ productId: string; day: string; qty: number }>(
      `SELECT i.product_id AS "productId", to_char((o.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, sum(i.quantity)::int AS qty
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.status <> 'CANCELLED' AND i.product_id = ANY($1::uuid[]) AND (o.created_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
       GROUP BY 1, 2`, [productIds, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]);
    for (const r of rows) {
      const arr = series.get(r.productId) ?? new Array<number>(HISTORY_DAYS).fill(0);
      const idx = Math.round((Date.parse(`${r.day}T00:00:00Z`) - start.getTime()) / 86_400_000);
      if (idx >= 0 && idx < HISTORY_DAYS) arr[idx] = r.qty;
      series.set(r.productId, arr);
    }
    return { series, startDow: start.getUTCDay() };
  }

  /**
   * One DRAFT purchase order per usual supplier. Products already on an open PO are skipped (so a second click is a no-op) and products
   * with no supplier history are returned, never dropped. Serialised across requests and replicas with an advisory lock.
   */
  async createPurchaseOrders(only: string[] | undefined, userId: string | null): Promise<{ created: PurchaseOrder[]; unassigned: ReorderSuggestion[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
      const all = await this.suggestions(only);
      const unassigned = all.filter((s) => !s.supplierId);
      const bySupplier = new Map<string, ReorderSuggestion[]>();
      for (const s of all) if (s.supplierId) bySupplier.set(s.supplierId, [...(bySupplier.get(s.supplierId) ?? []), s]);
      if (!bySupplier.size) return { created: [], unassigned };
      const warehouseId = await this.defaultWarehouse();
      const created: PurchaseOrder[] = [];
      for (const [supplierId, items] of bySupplier) {
        created.push(await this.orders.create({ supplierId, warehouseId, notes: 'Created from reorder suggestions',
          lines: items.map((s) => ({ productId: s.productId, quantity: s.suggestedQuantity, unitCostCents: s.unitCostCents })) }, userId));
      }
      return { created, unassigned };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
      client.release();
    }
  }

  private async defaultWarehouse(): Promise<string> {
    const { defaultWarehouseId } = await this.settings.get();
    if (defaultWarehouseId) return defaultWarehouseId;
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM warehouses ORDER BY code LIMIT 1');
    if (!rows[0]) throw new ConflictError('Create a warehouse before ordering stock');
    return rows[0].id;
  }
}
