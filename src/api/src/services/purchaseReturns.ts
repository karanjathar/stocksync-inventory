import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { DebitNoteSnapshot, PurchaseReturn } from '../domain/types.js';
import { MAX_TOTAL_CENTS } from './purchases.js';
import type { SettingsService } from './settings.js';
import type { StockService } from './stock.js';

export const formatDebitNoteNumber = (year: number, n: number): string => `DN-${year}-${String(n).padStart(6, '0')}`;

export interface PurchaseReturnInput { requestId: string; warehouseId: string; lines: { itemId: string; quantity: number }[]; reason?: string }

const SELECT = `
  SELECT r.id, r.number, r.debit_note_number AS "debitNoteNumber", r.purchase_order_id AS "purchaseOrderId", po.number AS "purchaseOrderNumber",
         r.supplier_id AS "supplierId", s.name AS "supplierName", r.warehouse_id AS "warehouseId", r.debit_total_cents AS "debitTotalCents",
         r.applied_cents AS "appliedCents", r.unapplied_cents AS "unappliedCents", r.reason, r.request_id AS "requestId", r.created_at AS "createdAt", r.snapshot
  FROM purchase_returns r JOIN purchase_orders po ON po.id = r.purchase_order_id JOIN suppliers s ON s.id = r.supplier_id`;

type Row = Omit<PurchaseReturn, 'items'>;

/**
 * Returning received goods to a supplier. Stock leaves through StockService (never below zero). The debit note lowers what is owed on
 * the order's bills, but only for billed value above what was kept: goods that were never billed just reduce what can still be billed,
 * and anything beyond the open balances (bills already paid) is recorded as owed BY the supplier.
 */
export class PurchaseReturnsService {
  constructor(private readonly pool: pg.Pool, private readonly stock: StockService, private readonly settings: SettingsService) {}

  async create(poId: string, input: PurchaseReturnInput, userId: string | null): Promise<{ purchaseReturn: PurchaseReturn; created: boolean }> {
    const merged = new Map<string, number>();
    for (const l of input.lines) {
      if (merged.has(l.itemId)) throw new ValidationError('Each purchase order line may appear only once per return');
      merged.set(l.itemId, l.quantity);
    }
    if (!merged.size) throw new ValidationError('A return needs at least one line');
    const s = await this.settings.get(); // read before the transaction (a second pooled connection inside it can starve the pool)

    const out = await withTx(this.pool, async (c) => {
      const { rows: [po] } = await c.query<{ number: number; status: string; supplierId: string }>(
        'SELECT number, status, supplier_id AS "supplierId" FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId]);
      if (!po) throw new NotFoundError('Purchase order');

      const { rows: [prior] } = await c.query<{ id: string; purchaseOrderId: string; warehouseId: string }>(
        'SELECT id, purchase_order_id AS "purchaseOrderId", warehouse_id AS "warehouseId" FROM purchase_returns WHERE request_id = $1', [input.requestId]);
      if (prior) {
        const { rows: had } = await c.query<{ itemId: string; quantity: number }>('SELECT purchase_order_item_id AS "itemId", quantity FROM purchase_return_items WHERE purchase_return_id = $1', [prior.id]);
        const same = prior.purchaseOrderId === poId && prior.warehouseId === input.warehouseId && had.length === merged.size && had.every((h) => merged.get(h.itemId) === h.quantity);
        if (!same) throw new ConflictError('This request id was already used for a different return');
        return { id: prior.id, created: false, changes: [] as Awaited<ReturnType<StockService['applyMany']>> };
      }
      if (po.status !== 'PARTIALLY_RECEIVED' && po.status !== 'RECEIVED' && po.status !== 'CLOSED') {
        throw new ConflictError(`Nothing has been received on this purchase order (it is ${po.status})`);
      }
      if (!(await c.query('SELECT 1 FROM warehouses WHERE id = $1', [input.warehouseId])).rowCount) throw new NotFoundError('Warehouse');

      const { rows: items } = await c.query<{ id: string; productId: string; sku: string; name: string; received: number; unitCostCents: number; returned: number }>(
        `SELECT poi.id, poi.product_id AS "productId", p.sku, p.name, poi.received_quantity AS received, poi.unit_cost_cents AS "unitCostCents",
                COALESCE((SELECT SUM(pri.quantity) FROM purchase_return_items pri WHERE pri.purchase_order_item_id = poi.id), 0)::int AS returned
         FROM purchase_order_items poi JOIN products p ON p.id = poi.product_id WHERE poi.purchase_order_id = $1`, [poId]);
      const byId = new Map(items.map((i) => [i.id, i]));
      const lines: { item: (typeof items)[number]; quantity: number; debit: number }[] = [];
      for (const [itemId, quantity] of merged) {
        const item = byId.get(itemId);
        if (!item) throw new NotFoundError('Purchase order item');
        const left = item.received - item.returned;
        if (quantity > left) throw new ConflictError(`Cannot return ${quantity} of ${item.sku}: only ${left} can still be returned`);
        lines.push({ item, quantity, debit: quantity * item.unitCostCents });
      }
      const debitTotal = lines.reduce((n, l) => n + l.debit, 0);
      if (debitTotal > MAX_TOTAL_CENTS) throw new ValidationError('Return total is too large');

      // How much of the billed value is now more than the goods we kept?
      const keptAfter = items.reduce((n, i) => n + (i.received - i.returned - (merged.get(i.id) ?? 0)) * i.unitCostCents, 0);
      const { rows: [sums] } = await c.query<{ billed: string; debited: string }>(
        "SELECT coalesce(sum(total_cents::bigint), 0)::text AS billed, coalesce(sum(debit_cents::bigint), 0)::text AS debited FROM bills WHERE purchase_order_id = $1 AND status <> 'VOID'", [poId]);
      const need = Math.max(0, Number(sums!.billed) - Number(sums!.debited) - keptAfter);
      let left = need;
      const { rows: open } = await c.query<{ id: string; total: number; paid: number; debit: number }>(
        "SELECT id, total_cents AS total, paid_cents AS paid, debit_cents AS debit FROM bills WHERE purchase_order_id = $1 AND status IN ('UNPAID', 'PARTIAL') ORDER BY number FOR UPDATE", [poId]);
      for (const b of open) {
        if (left <= 0) break;
        const take = Math.min(b.total - b.paid - b.debit, left);
        if (take <= 0) continue;
        const covered = b.paid + b.debit + take;
        await c.query('UPDATE bills SET debit_cents = debit_cents + $2, status = $3 WHERE id = $1', [b.id, take, covered === b.total ? 'PAID' : 'PARTIAL']);
        left -= take;
      }
      const applied = need - left;

      const seq = await c.query<{ number: number }>("SELECT nextval(pg_get_serial_sequence('purchase_returns', 'number'))::int AS number");
      const number = seq.rows[0]!.number;
      const { rows: [counter] } = await c.query<{ year: number; last: number }>(
        `INSERT INTO debit_note_counters (year, last) VALUES (extract(year FROM now())::int, 1)
         ON CONFLICT (year) DO UPDATE SET last = debit_note_counters.last + 1 RETURNING year, last`);
      const { rows: [sup] } = await c.query<{ name: string; email: string | null; phone: string | null }>('SELECT name, email, phone FROM suppliers WHERE id = $1', [po.supplierId]);
      const snapshot: DebitNoteSnapshot = {
        currency: s.currency, business: { businessName: s.businessName, taxId: s.taxId, address: s.businessAddress },
        supplier: { name: sup!.name, email: sup!.email, phone: sup!.phone }, purchaseOrderNumber: po.number,
      };
      const { rows: [ret] } = await c.query<{ id: string }>(
        `INSERT INTO purchase_returns (number, debit_note_number, purchase_order_id, supplier_id, warehouse_id, debit_total_cents, applied_cents, unapplied_cents, request_id, reason, snapshot, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [number, formatDebitNoteNumber(counter!.year, counter!.last), poId, po.supplierId, input.warehouseId, debitTotal, applied, left, input.requestId, input.reason ?? '', JSON.stringify(snapshot), userId]);
      for (const l of lines) {
        await c.query('INSERT INTO purchase_return_items (purchase_return_id, purchase_order_item_id, quantity, debit_cents) VALUES ($1, $2, $3, $4)', [ret!.id, l.item.id, l.quantity, l.debit]);
      }
      // Goods leave stock only through StockService; it refuses to go below zero (the whole return then rolls back).
      const changes = await this.stock.applyMany(c, lines.map((l) => ({
        productId: l.item.productId, warehouseId: input.warehouseId, delta: -l.quantity, type: 'OUT' as const,
        reason: `Return to supplier (PO #${po.number})`, reference: `PRET-${number}`, userId,
      })));
      return { id: ret!.id, created: true, changes };
    });
    await this.stock.notify(out.changes);
    return { purchaseReturn: (await this.get(out.id))!, created: out.created };
  }

  async get(id: string): Promise<PurchaseReturn | undefined> {
    const { rows } = await this.pool.query<Row>(`${SELECT} WHERE r.id = $1`, [id]);
    return rows[0] ? (await this.withItems(rows))[0] : undefined;
  }

  async list(f: { purchaseOrderId?: string; supplierId?: string; limit?: number } = {}): Promise<PurchaseReturn[]> {
    const values: unknown[] = [];
    const conds: string[] = [];
    if (f.purchaseOrderId) { values.push(f.purchaseOrderId); conds.push(`r.purchase_order_id = $${values.length}`); }
    if (f.supplierId) { values.push(f.supplierId); conds.push(`r.supplier_id = $${values.length}`); }
    values.push(Math.min(f.limit ?? 200, 500));
    const { rows } = await this.pool.query<Row>(`${SELECT} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY r.number DESC LIMIT $${values.length}`, values);
    return this.withItems(rows);
  }

  private async withItems(rows: Row[]): Promise<PurchaseReturn[]> {
    if (!rows.length) return [];
    const { rows: items } = await this.pool.query<PurchaseReturn['items'][number] & { returnId: string }>(
      `SELECT pri.purchase_return_id AS "returnId", pri.purchase_order_item_id AS "purchaseOrderItemId", p.sku, p.name, pri.quantity,
              poi.unit_cost_cents AS "unitCostCents", pri.debit_cents AS "debitCents"
       FROM purchase_return_items pri JOIN purchase_order_items poi ON poi.id = pri.purchase_order_item_id JOIN products p ON p.id = poi.product_id
       WHERE pri.purchase_return_id = ANY($1::uuid[]) ORDER BY p.sku`, [rows.map((r) => r.id)]);
    return rows.map((r) => ({ ...r, items: items.filter((i) => i.returnId === r.id).map(({ returnId: _r, ...i }) => i) }));
  }
}
