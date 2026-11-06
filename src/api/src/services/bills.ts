import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Bill, BillPayment, BillStatus, Payables, PayablesRow } from '../domain/types.js';

export interface NewBill {
  purchaseOrderId?: string;
  supplierId?: string;
  /** Required without a purchase order; with one it may only lower the billed amount. */
  amountCents?: number;
  dueDate?: string;
}
export interface NewBillPayment { requestId: string; amountCents: number; method: string }

const BILL_SELECT = `
  SELECT b.id, b.number, b.supplier_id AS "supplierId", s.name AS "supplierName", b.purchase_order_id AS "purchaseOrderId", b.status,
         b.total_cents AS "totalCents", b.paid_cents AS "paidCents", b.debit_cents AS "debitCents", to_char(b.due_date, 'YYYY-MM-DD') AS "dueDate", b.created_at AS "createdAt"
  FROM bills b JOIN suppliers s ON s.id = b.supplier_id`;
const PAYMENT_SELECT = `
  SELECT bill_id AS "billId", id, amount_cents AS "amountCents", request_id AS "requestId", method, paid_at AS "paidAt"
  FROM bill_payments WHERE bill_id = ANY($1::uuid[]) ORDER BY paid_at, id`;

type BillRow = Omit<Bill, 'payments'>;

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Supplier bills and payments. All amounts are integer minor units; bill rows are locked while money moves. */
export class BillsService {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: NewBill): Promise<Bill> {
    const id = await withTx(this.pool, async (c) => {
      let supplierId: string;
      let total: number;
      if (input.purchaseOrderId) {
        // Lock the PO so two clerks billing the same receipt cannot both succeed.
        const po = await c.query<{ supplierId: string }>('SELECT supplier_id AS "supplierId" FROM purchase_orders WHERE id = $1 FOR UPDATE', [input.purchaseOrderId]);
        if (!po.rows[0]) throw new NotFoundError('Purchase order');
        supplierId = po.rows[0].supplierId;
        // Goods already sent back to the supplier are not billable.
        const received = await c.query<{ v: string }>(
          `SELECT coalesce(sum((poi.received_quantity - coalesce(r.qty, 0))::bigint * poi.unit_cost_cents), 0)::text AS v
           FROM purchase_order_items poi
           LEFT JOIN (SELECT purchase_order_item_id, sum(quantity) AS qty FROM purchase_return_items GROUP BY purchase_order_item_id) r ON r.purchase_order_item_id = poi.id
           WHERE poi.purchase_order_id = $1`, [input.purchaseOrderId]);
        const billed = await c.query<{ v: string }>("SELECT coalesce(sum(total_cents::bigint), 0)::text AS v FROM bills WHERE purchase_order_id = $1 AND status <> 'VOID'", [input.purchaseOrderId]);
        const billable = Number(received.rows[0]!.v) - Number(billed.rows[0]!.v);
        if (billable <= 0) throw new ConflictError('Nothing left to bill: bill only received goods that are not already billed');
        total = input.amountCents ?? billable;
        if (total > billable) throw new ConflictError(`Cannot bill ${total}: only ${billable} of received goods is unbilled`);
      } else {
        if (!input.supplierId) throw new ValidationError('A purchase order or a supplier is required');
        if (input.amountCents === undefined) throw new ValidationError('An amount is required for a bill without a purchase order');
        if (!(await c.query('SELECT 1 FROM suppliers WHERE id = $1', [input.supplierId])).rowCount) throw new NotFoundError('Supplier');
        supplierId = input.supplierId;
        total = input.amountCents;
      }
      const { rows } = await c.query<{ id: string }>(
        'INSERT INTO bills (supplier_id, purchase_order_id, total_cents, due_date) VALUES ($1, $2, $3, $4) RETURNING id',
        [supplierId, input.purchaseOrderId ?? null, total, input.dueDate ?? addDays(30)]);
      return rows[0]!.id;
    });
    return (await this.get(id))!;
  }

  /** Records a payment once per requestId. Replays with identical details return the bill unchanged. */
  async pay(id: string, p: NewBillPayment): Promise<Bill> {
    await withTx(this.pool, async (c) => {
      const bill = await this.lock(c, id);
      const existing = await c.query<{ billId: string; amountCents: number; method: string }>('SELECT bill_id AS "billId", amount_cents AS "amountCents", method FROM bill_payments WHERE request_id = $1', [p.requestId]);
      if (existing.rows[0]) {
        if (existing.rows[0].billId === id && existing.rows[0].amountCents === p.amountCents && existing.rows[0].method === p.method) return;
        throw new ConflictError('This request id was already used for a different payment');
      }
      if (bill.status === 'VOID') throw new ConflictError('A void bill cannot be paid');
      const due = bill.totalCents - bill.paidCents - bill.debitCents;
      if (p.amountCents > due) throw new ConflictError(`Payment of ${p.amountCents} exceeds the ${due} still owed`);
      const paid = bill.paidCents + p.amountCents;
      await c.query('INSERT INTO bill_payments (bill_id, amount_cents, request_id, method) VALUES ($1, $2, $3, $4)', [id, p.amountCents, p.requestId, p.method]);
      await c.query('UPDATE bills SET paid_cents = $2, status = $3 WHERE id = $1', [id, paid, paid + bill.debitCents === bill.totalCents ? 'PAID' : 'PARTIAL']);
    });
    return (await this.get(id))!;
  }

  async void(id: string): Promise<Bill> {
    await withTx(this.pool, async (c) => {
      const bill = await this.lock(c, id);
      if (bill.status === 'VOID') throw new ConflictError('This bill is already void');
      if (bill.paidCents > 0) throw new ConflictError('A bill with payments cannot be voided');
      if (bill.debitCents > 0) throw new ConflictError('A bill with a debit note applied cannot be voided');
      await c.query("UPDATE bills SET status = 'VOID' WHERE id = $1", [id]);
    });
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Bill | undefined> {
    const { rows } = await this.pool.query<BillRow>(`${BILL_SELECT} WHERE b.id = $1`, [id]);
    if (!rows[0]) return undefined;
    return { ...rows[0], payments: (await this.payments([id])).get(id) ?? [] };
  }

  async list(f: { status?: BillStatus; supplierId?: string; limit?: number } = {}): Promise<Bill[]> {
    const values: unknown[] = [];
    const conds: string[] = [];
    if (f.status) { values.push(f.status); conds.push(`b.status = $${values.length}`); }
    if (f.supplierId) { values.push(f.supplierId); conds.push(`b.supplier_id = $${values.length}`); }
    values.push(Math.min(f.limit ?? 200, 500));
    const { rows } = await this.pool.query<BillRow>(`${BILL_SELECT} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY b.number DESC LIMIT $${values.length}`, values);
    const pays = await this.payments(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, payments: pays.get(r.id) ?? [] }));
  }

  /** Open balance per supplier (void and fully paid bills are ignored). Overdue = due before today. */
  async payables(): Promise<Payables> {
    const { rows } = await this.pool.query<{ supplierId: string; supplierName: string; open: string; overdue: string; n: number }>(
      `SELECT b.supplier_id AS "supplierId", s.name AS "supplierName",
              sum(b.total_cents - b.paid_cents - b.debit_cents)::text AS open,
              coalesce(sum(b.total_cents - b.paid_cents - b.debit_cents) FILTER (WHERE b.due_date < current_date), 0)::text AS overdue,
              count(*)::int AS n
       FROM bills b JOIN suppliers s ON s.id = b.supplier_id
       WHERE b.status IN ('UNPAID', 'PARTIAL') GROUP BY b.supplier_id, s.name ORDER BY s.name`);
    const suppliers: PayablesRow[] = rows.map((r) => ({ supplierId: r.supplierId, supplierName: r.supplierName, openCents: Number(r.open), overdueCents: Number(r.overdue), billCount: r.n }));
    return {
      suppliers,
      totalOpenCents: suppliers.reduce((n, r) => n + r.openCents, 0),
      totalOverdueCents: suppliers.reduce((n, r) => n + r.overdueCents, 0),
    };
  }

  private async payments(ids: string[]): Promise<Map<string, BillPayment[]>> {
    const out = new Map<string, BillPayment[]>();
    if (!ids.length) return out;
    const { rows } = await this.pool.query<BillPayment & { billId: string }>(PAYMENT_SELECT, [ids]);
    for (const { billId, ...p } of rows) out.set(billId, [...(out.get(billId) ?? []), p]);
    return out;
  }

  private async lock(c: pg.PoolClient, id: string) {
    const { rows } = await c.query<{ status: BillStatus; totalCents: number; paidCents: number; debitCents: number }>(
      'SELECT status, total_cents AS "totalCents", paid_cents AS "paidCents", debit_cents AS "debitCents" FROM bills WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new NotFoundError('Bill');
    return rows[0];
  }
}
