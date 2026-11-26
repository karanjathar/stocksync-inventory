import type pg from 'pg';
import { ConflictError } from '../domain/errors.js';
import type { PurchaseOrder } from '../domain/types.js';
import type { PurchaseOrdersService } from './purchaseOrders.js';
import type { SettingsService } from './settings.js';

export interface ReorderSuggestion {
  productId: string; sku: string; name: string; unit: string; totalQuantity: number; reorderLevel: number;
  onOrderQuantity: number; suggestedQuantity: number; supplierId: string | null; supplierName: string | null; unitCostCents: number;
}

const LOCK_KEY = 727275;

/** Reorder suggestions: low products, minus what is already on open purchase orders (target = 2 × reorder level). */
export class ReorderService {
  constructor(private readonly pool: pg.Pool, private readonly orders: PurchaseOrdersService, private readonly settings: SettingsService) {}

  async suggestions(only?: string[]): Promise<ReorderSuggestion[]> {
    const { rows } = await this.pool.query<ReorderSuggestion>(
      `SELECT p.id AS "productId", p.sku, p.name, p.unit, p.reorder_level AS "reorderLevel", t.total AS "totalQuantity",
              COALESCE(oo.qty, 0) AS "onOrderQuantity", GREATEST(p.reorder_level * 2 - t.total - COALESCE(oo.qty, 0), 0) AS "suggestedQuantity",
              last.supplier_id AS "supplierId", s.name AS "supplierName", COALESCE(last.cost, 0) AS "unitCostCents"
       FROM products p
       CROSS JOIN LATERAL (SELECT COALESCE(sum(quantity), 0)::int AS total FROM stock_levels WHERE product_id = p.id) t
       LEFT JOIN LATERAL (SELECT sum(l.quantity - l.received_quantity)::int AS qty FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
                          WHERE l.product_id = p.id AND po.status IN ('DRAFT','SENT','PARTIALLY_RECEIVED')) oo ON true
       LEFT JOIN LATERAL (SELECT po.supplier_id, l.unit_cost_cents AS cost FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
                          WHERE l.product_id = p.id AND po.status <> 'CANCELLED' ORDER BY po.created_at DESC, po.number DESC LIMIT 1) last ON true
       LEFT JOIN suppliers s ON s.id = last.supplier_id
       WHERE p.is_active AND p.reorder_level > 0 AND t.total <= p.reorder_level
         AND GREATEST(p.reorder_level * 2 - t.total - COALESCE(oo.qty, 0), 0) > 0
         AND ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))
       ORDER BY p.sku`, [only ?? null]);
    return rows;
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
