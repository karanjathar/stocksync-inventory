import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { ConflictError, ValidationError } from '../domain/errors.js';
import type { PurchaseOrder } from '../domain/types.js';
import { MAX_TOTAL_CENTS, type PurchasesService } from './purchases.js';
import type { SettingsService } from './settings.js';

export interface ReorderSuggestion {
  productId: string; sku: string; name: string; unit: string;
  onHand: number; incoming: number; reorderLevel: number; reorderQuantity: number;
  suggestedQuantity: number; supplierId: string | null; supplierName: string | null; lastCostCents: number;
}
export interface ReorderResult { orders: PurchaseOrder[]; skipped: { productId: string; reason: string }[] }

const ADVISORY_KEY = 727275; // serialises "create orders from suggestions" across requests and replicas

/**
 * Suggested quantity: the product's reorder quantity if set, otherwise enough to refill to twice the reorder level (at least 1).
 * Goods already on a draft, sent or partly received purchase order count as stock, so nothing is ordered twice.
 */
const SUGGESTION_SQL = `
  SELECT p.id AS "productId", p.sku, p.name, p.unit,
         COALESCE(s.total, 0)::int AS "onHand", COALESCE(inc.qty, 0)::int AS incoming,
         p.reorder_level AS "reorderLevel", p.reorder_quantity AS "reorderQuantity",
         CASE WHEN p.reorder_quantity > 0 THEN p.reorder_quantity
              ELSE GREATEST(1, 2 * p.reorder_level - (COALESCE(s.total, 0) + COALESCE(inc.qty, 0))) END::int AS "suggestedQuantity",
         p.preferred_supplier_id AS "supplierId", sup.name AS "supplierName", COALESCE(lc.cost, 0)::int AS "lastCostCents"
  FROM products p
  LEFT JOIN (SELECT product_id, SUM(quantity) AS total FROM stock_levels GROUP BY product_id) s ON s.product_id = p.id
  LEFT JOIN (SELECT i.product_id, SUM(i.quantity - i.received_quantity) AS qty
             FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.purchase_order_id
             WHERE o.status IN ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED') GROUP BY i.product_id) inc ON inc.product_id = p.id
  LEFT JOIN suppliers sup ON sup.id = p.preferred_supplier_id
  LEFT JOIN LATERAL (SELECT i.unit_cost_cents AS cost FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.purchase_order_id
                     WHERE i.product_id = p.id ORDER BY o.created_at DESC, o.number DESC LIMIT 1) lc ON true
  WHERE p.is_active AND p.reorder_level > 0 AND COALESCE(s.total, 0) + COALESCE(inc.qty, 0) <= p.reorder_level`;

export class ReorderService {
  constructor(private readonly pool: pg.Pool, private readonly purchases: PurchasesService, private readonly settings: SettingsService) {}

  async suggestions(db: Pick<pg.Pool, 'query'> = this.pool): Promise<ReorderSuggestion[]> {
    const { rows } = await db.query<ReorderSuggestion>(`${SUGGESTION_SQL} ORDER BY p.name`);
    return rows;
  }

  /**
   * Creates one DRAFT order per preferred supplier in a single transaction. The advisory lock is transaction-scoped and taken on
   * the same connection that does the work, so concurrent requests queue on it without holding a second pooled connection
   * and a failure can never leave the lock behind or some suppliers' orders half-created.
   */
  async createDrafts(productIds: string[], warehouseId: string | undefined, userId: string | null): Promise<ReorderResult> {
    const warehouse = warehouseId ?? (await this.settings.get()).defaultWarehouseId;
    if (!warehouse) throw new ValidationError('A warehouse is required (pass warehouseId or set a default warehouse in Settings)');
    const wanted = new Set(productIds);
    const { orderIds, skipped } = await withTx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_KEY]);
      const all = (await this.suggestions(c)).filter((s) => wanted.has(s.productId));
      const known = new Set(all.map((s) => s.productId));
      const skipped: ReorderResult['skipped'] = [];
      const { rows: exist } = await c.query<{ id: string }>('SELECT id FROM products WHERE id = ANY($1::uuid[])', [[...wanted]]);
      const existing = new Set(exist.map((r) => r.id));
      for (const id of wanted) {
        if (!known.has(id)) skipped.push({ productId: id, reason: existing.has(id) ? 'Not below its reorder level (or already on order, inactive or untracked)' : 'Product not found' });
      }
      const bySupplier = new Map<string, ReorderSuggestion[]>();
      for (const s of all) {
        if (!s.supplierId) { skipped.push({ productId: s.productId, reason: 'No preferred supplier set' }); continue; }
        bySupplier.set(s.supplierId, [...(bySupplier.get(s.supplierId) ?? []), s]);
      }
      const orderIds: string[] = [];
      for (const [supplierId, lines] of bySupplier) {
        const total = lines.reduce((n, l) => n + l.suggestedQuantity * l.lastCostCents, 0);
        if (total > MAX_TOTAL_CENTS) {
          for (const l of lines) skipped.push({ productId: l.productId, reason: 'Order total too large: lower the reorder quantity or order manually' });
          continue;
        }
        orderIds.push(await this.purchases.createWith(c, {
          supplierId, warehouseId: warehouse, userId, notes: 'Created from reorder suggestions',
          items: lines.map((l) => ({ productId: l.productId, quantity: l.suggestedQuantity, unitCostCents: l.lastCostCents })),
        }));
      }
      if (!orderIds.length) throw new ConflictError('Nothing to order', { skipped });
      return { orderIds, skipped };
    });
    const orders = [];
    for (const id of orderIds) orders.push((await this.purchases.get(id))!);
    return { orders, skipped };
  }
}
