import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { PurchaseOrder, PurchaseOrderLine, PurchaseOrderStatus } from '../domain/types.js';
import type { StockService } from './stock.js';

export interface PoLineInput { productId: string; quantity: number; unitCostCents: number }
export interface NewPurchaseOrder { supplierId: string; warehouseId: string; lines: PoLineInput[]; notes?: string }
export interface PurchaseOrderPatch { supplierId?: string; warehouseId?: string; lines?: PoLineInput[]; notes?: string }

const HEADER = `
  SELECT po.id, po.number, po.supplier_id AS "supplierId", s.name AS "supplierName", po.warehouse_id AS "warehouseId",
         po.status, po.notes, po.created_at AS "createdAt", po.updated_at AS "updatedAt"
  FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id`;

type Client = Pick<pg.PoolClient, 'query'>;

/** Purchase orders. Stock arrives only through StockService (one transaction per receive call). */
export class PurchaseOrdersService {
  constructor(private readonly pool: pg.Pool, private readonly stock: StockService) {}

  async create(input: NewPurchaseOrder, userId: string | null): Promise<PurchaseOrder> {
    const id = await withTx(this.pool, async (c) => {
      await this.assertRefs(c, input.supplierId, input.warehouseId, input.lines);
      const { rows } = await c.query<{ id: string }>(
        'INSERT INTO purchase_orders (supplier_id, warehouse_id, notes, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [input.supplierId, input.warehouseId, input.notes ?? '', userId]);
      await this.writeLines(c, rows[0]!.id, input.lines);
      return rows[0]!.id;
    });
    return (await this.get(id))!;
  }

  async update(id: string, patch: PurchaseOrderPatch): Promise<PurchaseOrder> {
    await withTx(this.pool, async (c) => {
      const po = await this.lock(c, id);
      if (po.status !== 'DRAFT') throw new ConflictError(`Only DRAFT purchase orders can be edited (this one is ${po.status})`);
      const next = { supplierId: patch.supplierId ?? po.supplier_id, warehouseId: patch.warehouseId ?? po.warehouse_id };
      await this.assertRefs(c, next.supplierId, next.warehouseId, patch.lines ?? []);
      await c.query('UPDATE purchase_orders SET supplier_id = $2, warehouse_id = $3, notes = COALESCE($4, notes), updated_at = now() WHERE id = $1',
        [id, next.supplierId, next.warehouseId, patch.notes ?? null]);
      if (patch.lines) {
        await c.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [id]);
        await this.writeLines(c, id, patch.lines);
      }
    });
    return (await this.get(id))!;
  }

  async send(id: string): Promise<PurchaseOrder> {
    return this.transition(id, 'DRAFT', 'SENT', 'Only DRAFT purchase orders can be sent');
  }

  async cancel(id: string): Promise<PurchaseOrder> {
    await withTx(this.pool, async (c) => {
      const po = await this.lock(c, id);
      if (po.status !== 'DRAFT' && po.status !== 'SENT') throw new ConflictError(`A ${po.status} purchase order cannot be cancelled`);
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM purchase_order_lines WHERE po_id = $1 AND received_quantity > 0', [id]);
      if (rows[0]!.n > 0) throw new ConflictError('Goods have already been received against this purchase order');
      await c.query("UPDATE purchase_orders SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [id]);
    });
    return (await this.get(id))!;
  }

  /** Idempotent on `receiptId`: a repeat returns the order unchanged. All lines apply or none do. */
  async receive(id: string, receiptId: string, lines: { productId: string; quantity: number }[], userId: string | null): Promise<PurchaseOrder> {
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l.productId)) throw new ValidationError('Invalid request', [{ path: 'lines', message: 'duplicate product' }]);
      seen.add(l.productId);
    }
    const changes = await withTx(this.pool, async (c) => {
      const po = await this.lock(c, id);
      const fresh = await c.query('INSERT INTO purchase_receipts (po_id, receipt_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, receiptId]);
      if (!fresh.rowCount) return null; // already processed
      if (po.status !== 'SENT' && po.status !== 'PARTIALLY_RECEIVED') throw new ConflictError(`Cannot receive goods on a ${po.status} purchase order`);
      for (const l of lines) {
        const { rowCount } = await c.query(
          'UPDATE purchase_order_lines SET received_quantity = received_quantity + $3 WHERE po_id = $1 AND product_id = $2 AND received_quantity + $3 <= quantity',
          [id, l.productId, l.quantity]);
        if (!rowCount) {
          const exists = await c.query('SELECT quantity, received_quantity FROM purchase_order_lines WHERE po_id = $1 AND product_id = $2', [id, l.productId]);
          if (!exists.rowCount) throw new ConflictError('Product is not on this purchase order');
          const { quantity, received_quantity } = exists.rows[0] as { quantity: number; received_quantity: number };
          throw new ConflictError(`Cannot receive ${l.quantity}: only ${quantity - received_quantity} still expected`);
        }
      }
      const applied = await this.stock.applyMany(c, lines.map((l) => ({
        productId: l.productId, warehouseId: po.warehouse_id, delta: l.quantity, type: 'IN' as const,
        reason: `Received against PO #${po.number}`, reference: `PO-${po.number}`, userId })));
      const open = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM purchase_order_lines WHERE po_id = $1 AND received_quantity < quantity', [id]);
      await c.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [id, open.rows[0]!.n === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED']);
      return applied;
    });
    if (changes) await this.stock.notify(changes);
    return (await this.get(id))!;
  }

  async get(id: string): Promise<PurchaseOrder | undefined> {
    const { rows } = await this.pool.query<Omit<PurchaseOrder, 'lines' | 'totalCents'>>(`${HEADER} WHERE po.id = $1`, [id]);
    if (!rows[0]) return undefined;
    return (await this.withLines(rows))[0];
  }

  async list(f: { status?: PurchaseOrderStatus; supplierId?: string; limit?: number } = {}): Promise<PurchaseOrder[]> {
    const where: string[] = []; const args: unknown[] = [];
    if (f.status) { args.push(f.status); where.push(`po.status = $${args.length}`); }
    if (f.supplierId) { args.push(f.supplierId); where.push(`po.supplier_id = $${args.length}`); }
    args.push(Math.min(f.limit ?? 100, 500));
    const { rows } = await this.pool.query<Omit<PurchaseOrder, 'lines' | 'totalCents'>>(
      `${HEADER} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY po.number DESC LIMIT $${args.length}`, args);
    return this.withLines(rows);
  }

  private async withLines(headers: Omit<PurchaseOrder, 'lines' | 'totalCents'>[]): Promise<PurchaseOrder[]> {
    if (!headers.length) return [];
    const { rows } = await this.pool.query<PurchaseOrderLine & { poId: string }>(
      `SELECT l.po_id AS "poId", l.product_id AS "productId", p.sku, p.name, l.quantity, l.received_quantity AS "receivedQuantity", l.unit_cost_cents AS "unitCostCents"
       FROM purchase_order_lines l JOIN products p ON p.id = l.product_id WHERE l.po_id = ANY($1::uuid[]) ORDER BY p.sku`, [headers.map((h) => h.id)]);
    return headers.map((h) => {
      const lines = rows.filter((l) => l.poId === h.id).map(({ poId: _poId, ...line }) => line);
      return { ...h, lines, totalCents: lines.reduce((sum, l) => sum + l.quantity * l.unitCostCents, 0) };
    });
  }

  private async transition(id: string, from: PurchaseOrderStatus, to: PurchaseOrderStatus, message: string): Promise<PurchaseOrder> {
    await withTx(this.pool, async (c) => {
      const po = await this.lock(c, id);
      if (po.status !== from) throw new ConflictError(`${message} (this one is ${po.status})`);
      await c.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [id, to]);
    });
    return (await this.get(id))!;
  }

  private async lock(c: Client, id: string): Promise<{ status: PurchaseOrderStatus; number: number; supplier_id: string; warehouse_id: string }> {
    const { rows } = await c.query<{ status: PurchaseOrderStatus; number: number; supplier_id: string; warehouse_id: string }>(
      'SELECT status, number, supplier_id, warehouse_id FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new NotFoundError('Purchase order');
    return rows[0];
  }

  private async assertRefs(c: Client, supplierId: string, warehouseId: string, lines: PoLineInput[]): Promise<void> {
    if (!(await c.query('SELECT 1 FROM suppliers WHERE id = $1', [supplierId])).rowCount) throw new NotFoundError('Supplier');
    if (!(await c.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId])).rowCount) throw new NotFoundError('Warehouse');
    if (lines.length) {
      const ids = lines.map((l) => l.productId);
      if (new Set(ids).size !== ids.length) throw new ValidationError('Invalid request', [{ path: 'lines', message: 'each product may appear once' }]);
      const found = await c.query('SELECT 1 FROM products WHERE id = ANY($1::uuid[])', [ids]);
      if (found.rowCount !== ids.length) throw new NotFoundError('Product');
    }
  }

  private async writeLines(c: Client, poId: string, lines: PoLineInput[]): Promise<void> {
    for (const l of lines) {
      await c.query('INSERT INTO purchase_order_lines (po_id, product_id, quantity, unit_cost_cents) VALUES ($1, $2, $3, $4)', [poId, l.productId, l.quantity, l.unitCostCents]);
    }
  }
}
