import type pg from 'pg';
import type { Logger } from 'pino';
import { withTx } from '../db/tx.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { Order, OrderStatus } from '../domain/types.js';
import { computeInvoice, type GstInvoiceTotals } from './gst.js';
import type { SettingsService } from './settings.js';

export interface InvoiceSnapshot {
  number: string; fy: string; issuedAt: string; currency: string; pricesIncludeTax: boolean;
  seller: { legalName: string; gstin: string; address: string; stateCode: string };
  buyer: { name: string; gstin: string | null; stateCode: string | null };
  order: { number: number; createdAt: string; channel: string };
  lines: GstInvoiceTotals['lines'];
  totals: Omit<GstInvoiceTotals, 'lines'>;
}
export interface Invoice {
  id: string; orderId: string; number: string; fy: string; seq: number; status: 'ISSUED' | 'VOID'; issuedAt: string;
  taxableCents: number; taxCents: number; totalCents: number; snapshot: InvoiceSnapshot;
}

const COLUMNS = `id, order_id AS "orderId", number, fy, seq, status, issued_at AS "issuedAt", taxable_cents AS "taxableCents",
  tax_cents AS "taxCents", total_cents AS "totalCents", snapshot`;

/** Indian financial year of an instant, e.g. 2026-11-26 → '2026-27'. The year changes at midnight IST on 1 April (UTC+5:30, no DST). */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** GST invoices (D-013, D-014, D-017): immutable snapshots with gapless sequential numbers per financial year. */
export class InvoiceService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly settings: SettingsService,
    private readonly now: () => Date = () => new Date(),
    private readonly logger?: Logger,
  ) {}

  async getByOrder(orderId: string): Promise<Invoice | undefined> {
    const { rows } = await this.pool.query<Invoice>(`SELECT ${COLUMNS} FROM invoices WHERE order_id = $1`, [orderId]);
    return rows[0];
  }

  /** Creates the invoice for a confirmed or fulfilled order, or returns the existing one (idempotent). */
  async issue(orderId: string): Promise<Invoice> {
    const existing = await this.getByOrder(orderId);
    if (existing) return existing;
    const s = await this.settings.get();
    const g = s.gst;
    if (!g.legalName || !g.gstin || !g.stateCode || !g.address) {
      throw new ConflictError('The GST profile is not set up: add the legal name, GSTIN, address and state in Settings → GST');
    }
    if (!g.pricesIncludeTax) {
      throw new ConflictError('Invoices need shop prices that include tax (MRP). Tax-exclusive pricing is not supported yet.');
    }

    const id = await withTx(this.pool, async (c) => {
      // Lock order first, then the year counter: every issuer takes locks in this order, so there is no deadlock.
      const o = (await c.query<{ status: OrderStatus; number: number; customerId: string; channel: string; createdAt: string; totalCents: number }>(
        `SELECT status, number, customer_id AS "customerId", channel, created_at AS "createdAt", total_cents AS "totalCents" FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!o) throw new NotFoundError('Order');
      const raced = await c.query<{ id: string }>('SELECT id FROM invoices WHERE order_id = $1', [orderId]);
      if (raced.rows[0]) return raced.rows[0].id;
      if (o.status !== 'CONFIRMED' && o.status !== 'FULFILLED') throw new ConflictError(`Only confirmed orders can be invoiced (this order is ${o.status})`);

      const customer = (await c.query<{ name: string; gstin: string | null; stateCode: string | null }>(
        'SELECT name, gstin, state_code AS "stateCode" FROM customers WHERE id = $1', [o.customerId])).rows[0]!;
      const items = (await c.query<{ productId: string; sku: string; name: string; hsnCode: string | null; gstRateBp: number; quantity: number; unitPriceCents: number }>(
        `SELECT oi.product_id AS "productId", p.sku, p.name, p.hsn_code AS "hsnCode", p.gst_rate_bp AS "gstRateBp", oi.quantity, oi.unit_price_cents AS "unitPriceCents"
         FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY p.sku`, [orderId])).rows;
      const calc = computeInvoice({ lines: items, pricesIncludeTax: true, sellerStateCode: g.stateCode, buyerStateCode: customer.stateCode });
      if (calc.totalCents !== o.totalCents) throw new Error(`invoice total ${calc.totalCents} differs from order total ${o.totalCents}`); // never issue a wrong document

      const issuedAt = this.now();
      const fy = financialYear(issuedAt);
      await c.query('INSERT INTO invoice_counters (fy, last_number) VALUES ($1, 0) ON CONFLICT DO NOTHING', [fy]);
      const seq = (await c.query<{ last_number: number }>('UPDATE invoice_counters SET last_number = last_number + 1 WHERE fy = $1 RETURNING last_number', [fy])).rows[0]!.last_number;
      const number = `${g.invoicePrefix}/${fy}/${String(seq).padStart(6, '0')}`;
      const { lines, ...totals } = calc;
      const snapshot: InvoiceSnapshot = {
        number, fy, issuedAt: issuedAt.toISOString(), currency: s.currency, pricesIncludeTax: true,
        seller: { legalName: g.legalName, gstin: g.gstin, address: g.address, stateCode: g.stateCode },
        buyer: { name: customer.name, gstin: customer.gstin, stateCode: customer.stateCode },
        order: { number: o.number, createdAt: o.createdAt, channel: o.channel }, lines, totals,
      };
      const ins = await c.query<{ id: string }>(
        `INSERT INTO invoices (order_id, fy, seq, number, issued_at, snapshot, taxable_cents, tax_cents, total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [orderId, fy, seq, number, issuedAt, JSON.stringify(snapshot), calc.taxableCents, calc.taxCents, calc.totalCents]);
      return ins.rows[0]!.id;
    });
    const { rows } = await this.pool.query<Invoice>(`SELECT ${COLUMNS} FROM invoices WHERE id = $1`, [id]);
    return rows[0]!;
  }

  /** Order observer: invoice on confirmation, void on cancellation. Never blocks the order itself. */
  async onOrderStatusChange(order: Order, previous: OrderStatus | null): Promise<void> {
    try {
      if (order.status === 'CONFIRMED' && previous === 'PENDING') await this.issue(order.id);
      else if (order.status === 'CANCELLED') await this.pool.query("UPDATE invoices SET status = 'VOID' WHERE order_id = $1 AND status = 'ISSUED'", [order.id]);
    } catch (err) {
      if (err instanceof ConflictError) this.logger?.info({ orderId: order.id, reason: err.message }, 'invoice not issued');
      else this.logger?.error({ err: String(err), orderId: order.id }, 'invoice issuing failed');
    }
  }
}
