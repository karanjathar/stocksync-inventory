import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { InsufficientStockError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { MovementType, StockLevel, StockMovement } from '../domain/types.js';

export interface StockChange { productId: string; warehouseId: string; quantity: number; delta: number }
export type StockObserver = (changes: StockChange[]) => void | Promise<void>;

export interface DeltaInput {
  productId: string;
  warehouseId: string;
  delta: number;
  type: MovementType;
  reason?: string;
  reference?: string | null;
  userId: string | null;
}

interface QtyInput { productId: string; warehouseId: string; quantity: number; reason?: string; reference?: string }

const LEVEL_SELECT = `
  SELECT sl.product_id AS "productId", p.sku, p.name AS "productName", sl.warehouse_id AS "warehouseId",
         w.code AS "warehouseCode", sl.quantity, sl.bin
  FROM stock_levels sl JOIN products p ON p.id = sl.product_id JOIN warehouses w ON w.id = sl.warehouse_id`;

export class StockService {
  private readonly observers: StockObserver[] = [];

  constructor(private readonly pool: pg.Pool, private readonly onError: (err: unknown) => void = () => {}) {}

  onChanged(observer: StockObserver): void {
    this.observers.push(observer);
  }

  async receive(i: QtyInput, userId: string | null): Promise<StockLevel> {
    return this.single({ ...i, delta: i.quantity, type: 'IN', userId });
  }

  async issue(i: QtyInput, userId: string | null): Promise<StockLevel> {
    return this.single({ ...i, delta: -i.quantity, type: 'OUT', userId });
  }

  async adjust(i: { productId: string; warehouseId: string; newQuantity: number; reason: string }, userId: string | null): Promise<StockLevel> {
    const changes = await withTx(this.pool, async (c) => {
      await this.assertExists(c, i.productId, [i.warehouseId]);
      await this.lockRows(c, i.productId, [i.warehouseId]);
      const { rows } = await c.query<{ quantity: number }>(
        'SELECT quantity FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [i.productId, i.warehouseId]);
      const current = rows[0]!.quantity;
      return [await this.applyDelta(c, { productId: i.productId, warehouseId: i.warehouseId, delta: i.newQuantity - current, type: 'ADJUST', reason: i.reason, userId })];
    });
    await this.notify(changes);
    return this.level(i.productId, i.warehouseId);
  }

  /** Sets or clears the bin/shelf location of a product in a warehouse. Changes no quantity. */
  async setBin(i: { productId: string; warehouseId: string; bin: string | null }): Promise<StockLevel> {
    await withTx(this.pool, async (c) => {
      await this.assertExists(c, i.productId, [i.warehouseId]);
      await c.query(
        `INSERT INTO stock_levels (product_id, warehouse_id, quantity, bin) VALUES ($1, $2, 0, $3)
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET bin = EXCLUDED.bin`, [i.productId, i.warehouseId, i.bin]);
    });
    return this.level(i.productId, i.warehouseId);
  }

  async transfer(i: { productId: string; fromWarehouseId: string; toWarehouseId: string; quantity: number; reason?: string }, userId: string | null) {
    if (i.fromWarehouseId === i.toWarehouseId) throw new ValidationError('Source and destination warehouses must differ');
    const reference = `TRF-${Date.now().toString(36).toUpperCase()}`;
    const changes = await withTx(this.pool, async (c) => {
      await this.assertExists(c, i.productId, [i.fromWarehouseId, i.toWarehouseId]);
      await this.lockRows(c, i.productId, [i.fromWarehouseId, i.toWarehouseId]);
      return [
        await this.applyDelta(c, { productId: i.productId, warehouseId: i.fromWarehouseId, delta: -i.quantity, type: 'TRANSFER_OUT', reason: i.reason, reference, userId }),
        await this.applyDelta(c, { productId: i.productId, warehouseId: i.toWarehouseId, delta: i.quantity, type: 'TRANSFER_IN', reason: i.reason, reference, userId }),
      ];
    });
    await this.notify(changes);
    return { from: await this.level(i.productId, i.fromWarehouseId), to: await this.level(i.productId, i.toWarehouseId) };
  }

  /** Applies several deltas inside an existing transaction (used by order confirmation). Caller must call notify() after commit. */
  async applyMany(c: pg.PoolClient, deltas: DeltaInput[]): Promise<StockChange[]> {
    const out: StockChange[] = [];
    // Consistent lock order prevents deadlocks between concurrent multi-row operations.
    const sorted = [...deltas].sort((a, b) => (a.productId + a.warehouseId).localeCompare(b.productId + b.warehouseId));
    for (const d of sorted) {
      await this.assertExists(c, d.productId, [d.warehouseId]);
      await this.lockRows(c, d.productId, [d.warehouseId]);
    }
    for (const d of sorted) out.push(await this.applyDelta(c, d));
    return out;
  }

  async notify(changes: StockChange[]): Promise<void> {
    for (const o of this.observers) {
      try { await o(changes); } catch (err) { this.onError(err); }
    }
  }

  async levels(f: { productId?: string; warehouseId?: string } = {}): Promise<StockLevel[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (f.productId) { values.push(f.productId); where.push(`sl.product_id = $${values.length}`); }
    if (f.warehouseId) { values.push(f.warehouseId); where.push(`sl.warehouse_id = $${values.length}`); }
    const { rows } = await this.pool.query<StockLevel>(
      `${LEVEL_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.name, w.code`, values);
    return rows;
  }

  async movements(f: { productId?: string; warehouseId?: string; limit?: number } = {}): Promise<StockMovement[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (f.productId) { values.push(f.productId); where.push(`m.product_id = $${values.length}`); }
    if (f.warehouseId) { values.push(f.warehouseId); where.push(`m.warehouse_id = $${values.length}`); }
    values.push(Math.min(f.limit ?? 100, 500));
    const { rows } = await this.pool.query<StockMovement>(
      `SELECT m.id, m.product_id AS "productId", p.sku, m.warehouse_id AS "warehouseId", w.code AS "warehouseCode",
              m.type, m.quantity_delta AS "quantityDelta", m.balance_after AS "balanceAfter", m.reason, m.reference,
              m.user_id AS "userId", m.created_at AS "createdAt"
       FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY m.created_at DESC, m.id DESC LIMIT $${values.length}`, values);
    return rows;
  }

  private async single(d: DeltaInput): Promise<StockLevel> {
    const changes = await withTx(this.pool, async (c) => {
      await this.assertExists(c, d.productId, [d.warehouseId]);
      return [await this.applyDelta(c, d)];
    });
    await this.notify(changes);
    return this.level(d.productId, d.warehouseId);
  }

  private async level(productId: string, warehouseId: string): Promise<StockLevel> {
    const { rows } = await this.pool.query<StockLevel>(`${LEVEL_SELECT} WHERE sl.product_id = $1 AND sl.warehouse_id = $2`, [productId, warehouseId]);
    return rows[0]!;
  }

  private async assertExists(c: pg.PoolClient, productId: string, warehouseIds: string[]): Promise<void> {
    const p = await c.query('SELECT 1 FROM products WHERE id = $1', [productId]);
    if (!p.rowCount) throw new NotFoundError('Product');
    const w = await c.query('SELECT id FROM warehouses WHERE id = ANY($1::uuid[])', [warehouseIds]);
    if (w.rowCount !== new Set(warehouseIds).size) throw new NotFoundError('Warehouse');
  }

  private async lockRows(c: pg.PoolClient, productId: string, warehouseIds: string[]): Promise<void> {
    for (const w of [...warehouseIds].sort()) {
      await c.query('INSERT INTO stock_levels (product_id, warehouse_id, quantity) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [productId, w]);
    }
    await c.query('SELECT 1 FROM stock_levels WHERE product_id = $1 AND warehouse_id = ANY($2::uuid[]) ORDER BY warehouse_id FOR UPDATE', [productId, warehouseIds]);
  }

  /** The single atomic write path: conditional update (never below zero) + immutable ledger row. */
  private async applyDelta(c: pg.PoolClient, d: DeltaInput): Promise<StockChange> {
    await c.query('INSERT INTO stock_levels (product_id, warehouse_id, quantity) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [d.productId, d.warehouseId]);
    const { rows } = await c.query<{ quantity: number }>(
      `UPDATE stock_levels SET quantity = quantity + $3
       WHERE product_id = $1 AND warehouse_id = $2 AND quantity + $3 >= 0 RETURNING quantity`,
      [d.productId, d.warehouseId, d.delta]);
    if (!rows[0]) {
      const cur = await c.query<{ quantity: number; sku: string }>(
        'SELECT sl.quantity, p.sku FROM stock_levels sl JOIN products p ON p.id = sl.product_id WHERE sl.product_id = $1 AND sl.warehouse_id = $2',
        [d.productId, d.warehouseId]);
      throw new InsufficientStockError({ sku: cur.rows[0]?.sku, available: cur.rows[0]?.quantity ?? 0, requested: -d.delta });
    }
    await c.query(
      `INSERT INTO stock_movements (product_id, warehouse_id, type, quantity_delta, balance_after, reason, reference, user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
      [d.productId, d.warehouseId, d.type, d.delta, rows[0].quantity, d.reason ?? '', d.reference ?? null, d.userId]);
    return { productId: d.productId, warehouseId: d.warehouseId, quantity: rows[0].quantity, delta: d.delta };
  }
}
