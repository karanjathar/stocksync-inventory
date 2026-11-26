import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { StockCount, StockCountLine, StockCountStatus } from '../domain/types.js';
import type { StockService } from './stock.js';

type Header = Omit<StockCount, 'lines'>;
const HEADER = `
  SELECT sc.id, sc.number, sc.warehouse_id AS "warehouseId", w.code AS "warehouseCode", sc.status,
         sc.created_at AS "createdAt", sc.submitted_at AS "submittedAt",
         (SELECT count(*)::int FROM stock_count_lines l WHERE l.count_id = sc.id) AS "lineCount"
  FROM stock_counts sc JOIN warehouses w ON w.id = sc.warehouse_id`;

/**
 * Stock counts: record what is physically on the shelf, then submit. Submitting sets each counted product to the counted quantity
 * through StockService (an ADJUST movement for every difference), once. Products not counted are left alone.
 */
export class StockCountsService {
  constructor(private readonly pool: pg.Pool, private readonly stock: StockService) {}

  async open(warehouseId: string, userId: string | null): Promise<StockCount> {
    if (!(await this.pool.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId])).rowCount) throw new NotFoundError('Warehouse');
    const { rows } = await this.pool.query<{ id: string }>('INSERT INTO stock_counts (warehouse_id, created_by) VALUES ($1, $2) RETURNING id', [warehouseId, userId]);
    return (await this.get(rows[0]!.id))!;
  }

  /** Upserts counted quantities (last write wins, so a resend or an offline sync is harmless). OPEN counts only. */
  async setLines(id: string, lines: { productId: string; countedQuantity: number }[]): Promise<StockCount> {
    await withTx(this.pool, async (c) => {
      await this.lockOpen(c, id);
      const ids = lines.map((l) => l.productId);
      const found = await c.query('SELECT 1 FROM products WHERE id = ANY($1::uuid[])', [[...new Set(ids)]]);
      if (found.rowCount !== new Set(ids).size) throw new NotFoundError('Product');
      for (const l of lines) {
        await c.query(
          `INSERT INTO stock_count_lines (count_id, product_id, counted_quantity) VALUES ($1, $2, $3)
           ON CONFLICT (count_id, product_id) DO UPDATE SET counted_quantity = EXCLUDED.counted_quantity`, [id, l.productId, l.countedQuantity]);
      }
    });
    return (await this.get(id))!;
  }

  async submit(id: string, userId: string | null): Promise<StockCount> {
    const changes = await withTx(this.pool, async (c) => {
      const sc = await this.lockOpen(c, id);
      const { rows: lines } = await c.query<{ productId: string; counted: number }>('SELECT product_id AS "productId", counted_quantity AS counted FROM stock_count_lines WHERE count_id = $1', [id]);
      if (!lines.length) throw new ConflictError('Nothing has been counted yet');
      const { changes: applied, before } = await this.stock.setQuantities(c, lines.map((l) => ({
        productId: l.productId, warehouseId: sc.warehouseId, newQuantity: l.counted, reason: `Stock count #${sc.number}`, reference: `COUNT-${sc.number}`, userId })));
      for (const l of lines) await c.query('UPDATE stock_count_lines SET system_quantity = $3 WHERE count_id = $1 AND product_id = $2', [id, l.productId, before.get(l.productId)]);
      await c.query("UPDATE stock_counts SET status = 'SUBMITTED', submitted_at = now() WHERE id = $1", [id]);
      return applied;
    });
    await this.stock.notify(changes);
    return (await this.get(id))!;
  }

  async cancel(id: string): Promise<StockCount> {
    await withTx(this.pool, async (c) => {
      await this.lockOpen(c, id);
      await c.query("UPDATE stock_counts SET status = 'CANCELLED' WHERE id = $1", [id]);
    });
    return (await this.get(id))!;
  }

  async get(id: string): Promise<StockCount | undefined> {
    const { rows } = await this.pool.query<Header>(`${HEADER} WHERE sc.id = $1`, [id]);
    if (!rows[0]) return undefined;
    // OPEN counts compare against what the system says right now; SUBMITTED ones against what it said at submit time.
    const { rows: lines } = await this.pool.query<StockCountLine>(
      `SELECT l.product_id AS "productId", p.sku, p.name, l.counted_quantity AS "countedQuantity",
              COALESCE(l.system_quantity, sl.quantity, 0) AS "systemQuantity",
              l.counted_quantity - COALESCE(l.system_quantity, sl.quantity, 0) AS variance
       FROM stock_count_lines l JOIN products p ON p.id = l.product_id
       LEFT JOIN stock_levels sl ON sl.product_id = l.product_id AND sl.warehouse_id = $2
       WHERE l.count_id = $1 ORDER BY p.sku`, [id, rows[0].warehouseId]);
    return { ...rows[0], lines };
  }

  async list(status?: StockCountStatus): Promise<Header[]> {
    const { rows } = await this.pool.query<Header>(`${HEADER} ${status ? 'WHERE sc.status = $1' : ''} ORDER BY sc.number DESC LIMIT 200`, status ? [status] : []);
    return rows;
  }

  private async lockOpen(c: Pick<pg.PoolClient, 'query'>, id: string): Promise<{ warehouseId: string; number: number }> {
    const { rows } = await c.query<{ status: StockCountStatus; warehouseId: string; number: number }>(
      'SELECT status, warehouse_id AS "warehouseId", number FROM stock_counts WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new NotFoundError('Stock count');
    if (rows[0].status !== 'OPEN') throw new ConflictError(`This count is already ${rows[0].status.toLowerCase()}`);
    return rows[0];
  }
}
