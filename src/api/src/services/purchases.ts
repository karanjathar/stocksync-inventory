import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { PurchaseOrder, PurchaseOrderItem, PurchaseStatus } from '../domain/types.js';
import type { StockService } from './stock.js';

export interface PurchaseLineInput { productId: string; quantity: number; unitCostCents: number }
export interface NewPurchaseOrder {
  supplierId: string;
  warehouseId: string;
  expectedDate?: string | null;
  notes?: string;
  items: PurchaseLineInput[];
  userId: string | null;
}
export interface ReceiveLine { itemId: string; quantity: number; warehouseId?: string }
export interface PurchasePatch {
  supplierId?: string;
  warehouseId?: string;
  expectedDate?: string | null;
  notes?: string;
  items?: PurchaseLineInput[];
}

/** The total_cents column is a 32-bit integer. */
export const MAX_TOTAL_CENTS = 2_147_483_647;

const PO_SELECT = `
  SELECT po.id, po.number, po.supplier_id AS "supplierId", s.name AS "supplierName", po.status, po.warehouse_id AS "warehouseId",
         to_char(po.expected_date, 'YYYY-MM-DD') AS "expectedDate", po.notes, po.total_cents AS "totalCents",
         po.created_by AS "createdBy", po.created_at AS "createdAt", po.updated_at AS "updatedAt"
  FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id`;

type PoRow = Omit<PurchaseOrder, 'items'>;

/** Purchase orders. Receiving stock against them is a separate step (T60) and always goes through StockService. */
export class PurchasesService {
  constructor(private readonly pool: pg.Pool, private readonly stock: StockService) {}

  async create(input: NewPurchaseOrder): Promise<PurchaseOrder> {
    const id = await withTx(this.pool, (c) => this.createWith(c, input));
    return (await this.get(id))!;
  }

  /** Inserts a DRAFT inside the caller's transaction (used to create several orders atomically). Returns the new id. */
  async createWith(c: pg.PoolClient, input: NewPurchaseOrder): Promise<string> {
    const total = this.total(input.items);
    await this.assertRefs(c, input.supplierId, input.warehouseId, input.items);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO purchase_orders (supplier_id, warehouse_id, expected_date, notes, total_cents, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.supplierId, input.warehouseId, input.expectedDate ?? null, input.notes ?? '', total, input.userId]);
    await this.insertItems(c, rows[0]!.id, input.items);
    return rows[0]!.id;
  }

  async update(id: string, patch: PurchasePatch): Promise<PurchaseOrder> {
    await withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      if (row.status !== 'DRAFT') throw new ConflictError(`Only DRAFT purchase orders can be edited (this one is ${row.status})`);
      const supplierId = patch.supplierId ?? row.supplierId;
      const warehouseId = patch.warehouseId ?? row.warehouseId;
      const items = patch.items ?? (await this.items(c, id)).map((i) => ({ productId: i.productId, quantity: i.quantity, unitCostCents: i.unitCostCents }));
      const total = this.total(items);
      await this.assertRefs(c, supplierId, warehouseId, items);
      await c.query(
        `UPDATE purchase_orders SET supplier_id = $2, warehouse_id = $3, expected_date = $4, notes = $5, total_cents = $6, updated_at = now() WHERE id = $1`,
        [id, supplierId, warehouseId, patch.expectedDate === undefined ? row.expectedDate : patch.expectedDate, patch.notes ?? row.notes, total]);
      if (patch.items) {
        await c.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1', [id]);
        await this.insertItems(c, id, patch.items);
      }
    });
    return (await this.get(id))!;
  }

  async send(id: string): Promise<PurchaseOrder> {
    await this.transition(id, ['DRAFT'], 'SENT', 'sent');
    return (await this.get(id))!;
  }

  async cancel(id: string): Promise<PurchaseOrder> {
    await this.transition(id, ['DRAFT', 'SENT'], 'CANCELLED', 'cancelled');
    return (await this.get(id))!;
  }

  /**
   * Books received goods through StockService (the only stock write path) in one transaction with the PO update.
   * The PO row and its item rows are locked, so concurrent or repeated submits cannot receive more than was ordered.
   */
  async receive(id: string, lines: ReceiveLine[], userId: string | null): Promise<PurchaseOrder> {
    if (!lines.length) throw new ValidationError('At least one line is required');
    if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw new ValidationError('Each item may appear only once per receipt');
    const changes = await withTx(this.pool, async (c) => {
      const po = await this.lock(c, id);
      if (po.status !== 'SENT' && po.status !== 'PARTIALLY_RECEIVED') {
        throw new ConflictError(`Only SENT or partially received purchase orders can be received (this one is ${po.status})`);
      }
      const { rows: items } = await c.query<{ id: string; productId: string; sku: string; quantity: number; received: number }>(
        `SELECT poi.id, poi.product_id AS "productId", p.sku, poi.quantity, poi.received_quantity AS received
         FROM purchase_order_items poi JOIN products p ON p.id = poi.product_id WHERE poi.purchase_order_id = $1 FOR UPDATE OF poi`, [id]);
      const byId = new Map(items.map((i) => [i.id, i]));
      const deltas = [];
      for (const l of lines) {
        const item = byId.get(l.itemId);
        if (!item) throw new NotFoundError('Purchase order item');
        const remaining = item.quantity - item.received;
        if (l.quantity > remaining) throw new ConflictError(`Cannot receive ${l.quantity} of ${item.sku}: only ${remaining} still expected`);
        deltas.push({
          productId: item.productId, warehouseId: l.warehouseId ?? po.warehouseId, delta: l.quantity, type: 'IN' as const,
          reason: `Purchase order #${po.number}`, reference: `PO-${po.number}`, userId,
        });
      }
      const applied = await this.stock.applyMany(c, deltas);
      for (const l of lines) {
        await c.query('UPDATE purchase_order_items SET received_quantity = received_quantity + $2 WHERE id = $1', [l.itemId, l.quantity]);
        byId.get(l.itemId)!.received += l.quantity;
      }
      const complete = [...byId.values()].every((i) => i.received === i.quantity);
      await c.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [id, complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED']);
      return applied;
    });
    await this.stock.notify(changes);
    return (await this.get(id))!;
  }

  async get(id: string): Promise<PurchaseOrder | undefined> {
    const { rows } = await this.pool.query<PoRow>(`${PO_SELECT} WHERE po.id = $1`, [id]);
    return rows[0] ? { ...rows[0], items: await this.items(this.pool, id) } : undefined;
  }

  async list(f: { status?: PurchaseStatus; supplierId?: string; limit?: number } = {}): Promise<PurchaseOrder[]> {
    const values: unknown[] = [];
    const conds: string[] = [];
    if (f.status) { values.push(f.status); conds.push(`po.status = $${values.length}`); }
    if (f.supplierId) { values.push(f.supplierId); conds.push(`po.supplier_id = $${values.length}`); }
    values.push(Math.min(f.limit ?? 200, 500));
    const { rows } = await this.pool.query<PoRow>(
      `${PO_SELECT} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY po.number DESC LIMIT $${values.length}`, values);
    if (!rows.length) return [];
    const { rows: items } = await this.pool.query<PurchaseOrderItem & { purchaseOrderId: string }>(ITEM_SELECT, [rows.map((r) => r.id)]);
    return rows.map((r) => ({ ...r, items: items.filter((i) => i.purchaseOrderId === r.id).map(({ purchaseOrderId: _p, ...i }) => i) }));
  }

  private total(items: PurchaseLineInput[]): number {
    const seen = new Set<string>();
    let total = 0;
    for (const i of items) {
      if (seen.has(i.productId)) throw new ValidationError('A product can appear only once per purchase order');
      seen.add(i.productId);
      total += i.quantity * i.unitCostCents;
      if (total > MAX_TOTAL_CENTS) throw new ValidationError('Purchase order total is too large');
    }
    if (!items.length) throw new ValidationError('A purchase order needs at least one item');
    return total;
  }

  private async assertRefs(c: pg.PoolClient, supplierId: string, warehouseId: string, items: PurchaseLineInput[]): Promise<void> {
    if (!(await c.query('SELECT 1 FROM suppliers WHERE id = $1', [supplierId])).rowCount) throw new NotFoundError('Supplier');
    if (!(await c.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId])).rowCount) throw new NotFoundError('Warehouse');
    const ids = items.map((i) => i.productId);
    const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM products WHERE id = ANY($1::uuid[])', [ids]);
    if (rows[0]!.n !== new Set(ids).size) throw new NotFoundError('Product');
  }

  private async insertItems(c: pg.PoolClient, poId: string, items: PurchaseLineInput[]): Promise<void> {
    for (const i of items) {
      await c.query('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_cost_cents) VALUES ($1, $2, $3, $4)',
        [poId, i.productId, i.quantity, i.unitCostCents]);
    }
  }

  private async transition(id: string, from: PurchaseStatus[], to: PurchaseStatus, verb: string): Promise<void> {
    await withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      if (!from.includes(row.status)) throw new ConflictError(`This purchase order cannot be ${verb} (it is ${row.status})`);
      await c.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [id, to]);
    });
  }

  private async lock(c: pg.PoolClient, id: string) {
    const { rows } = await c.query<{ status: PurchaseStatus; number: number; supplierId: string; warehouseId: string; expectedDate: string | null; notes: string }>(
      `SELECT status, number, supplier_id AS "supplierId", warehouse_id AS "warehouseId", to_char(expected_date, 'YYYY-MM-DD') AS "expectedDate", notes
       FROM purchase_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new NotFoundError('Purchase order');
    return rows[0];
  }

  private async items(c: Pick<pg.Pool, 'query'>, poId: string): Promise<PurchaseOrderItem[]> {
    const { rows } = await c.query<PurchaseOrderItem & { purchaseOrderId: string }>(ITEM_SELECT, [[poId]]);
    return rows.map(({ purchaseOrderId: _p, ...i }) => i);
  }
}

const ITEM_SELECT = `
  SELECT poi.purchase_order_id AS "purchaseOrderId", poi.id, poi.product_id AS "productId", p.sku, p.name, poi.quantity,
         poi.received_quantity AS "receivedQuantity", poi.unit_cost_cents AS "unitCostCents"
  FROM purchase_order_items poi JOIN products p ON p.id = poi.product_id
  WHERE poi.purchase_order_id = ANY($1::uuid[]) ORDER BY p.sku`;
