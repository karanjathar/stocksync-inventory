import type pg from 'pg';
import { NotFoundError } from '../domain/errors.js';
import type { Invoice, InvoiceLine, InvoiceStatus, Settings } from '../domain/types.js';

export const formatInvoiceNumber = (year: number, n: number): string => `INV-${year}-${String(n).padStart(6, '0')}`;

const SELECT = `
  SELECT i.id, i.order_id AS "orderId", o.number AS "orderNumber", i.number, i.status, i.currency, i.inclusive, i.seller, i.customer, i.lines,
         i.subtotal_cents AS "subtotalCents", i.discount_cents AS "discountCents", i.tax_cents AS "taxCents", i.total_cents AS "totalCents",
         i.issued_at AS "issuedAt", i.voided_at AS "voidedAt"
  FROM invoices i JOIN orders o ON o.id = i.order_id`;

/**
 * Invoices are immutable snapshots issued when an order is confirmed. Numbers are gapless per year because the counter row is
 * incremented inside the confirming transaction: a rollback also rolls the number back. A database trigger forbids edits and deletes.
 */
export class InvoicesService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Issues the invoice for an order inside the caller's transaction (the order row is already locked by the caller).
   * Settings are passed in, read before the transaction began: asking the pool for another connection here would
   * deadlock when every pooled connection is already held by a concurrent confirmation.
   */
  async issueWith(c: pg.PoolClient, orderId: string, s: Settings): Promise<void> {
    const { rows: [o] } = await c.query<{ customerId: string; inclusive: boolean; subtotal: number; discount: number; tax: number; total: number }>(
      `SELECT customer_id AS "customerId", prices_include_tax AS inclusive, subtotal_cents AS subtotal, discount_cents AS discount, tax_cents AS tax, total_cents AS total
       FROM orders WHERE id = $1`, [orderId]);
    if (!o) throw new NotFoundError('Order');
    const { rows: [cust] } = await c.query<{ name: string; phone: string | null; email: string | null }>('SELECT name, phone, email FROM customers WHERE id = $1', [o.customerId]);
    const { rows: lines } = await c.query<InvoiceLine>(
      `SELECT p.sku, p.name, oi.quantity, oi.unit_price_cents AS "unitPriceCents", oi.discount_cents AS "discountCents",
              (oi.unit_price_cents::bigint * oi.quantity - oi.discount_cents)::int AS "netCents", oi.tax_rate_bp AS "taxRateBp",
              oi.tax_cents AS "taxCents", oi.total_cents AS "totalCents"
       FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY p.sku`, [orderId]);
    const { rows: [counter] } = await c.query<{ year: number; last: number }>(
      `INSERT INTO invoice_counters (year, last) VALUES (extract(year FROM now())::int, 1)
       ON CONFLICT (year) DO UPDATE SET last = invoice_counters.last + 1 RETURNING year, last`);
    await c.query(
      `INSERT INTO invoices (order_id, number, currency, inclusive, seller, customer, lines, subtotal_cents, discount_cents, tax_cents, total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [orderId, formatInvoiceNumber(counter!.year, counter!.last), s.currency, o.inclusive,
        JSON.stringify({ businessName: s.businessName, taxId: s.taxId, address: s.businessAddress, whatsappNumber: s.whatsappNumber }),
        JSON.stringify({ name: cust!.name, phone: cust!.phone, email: cust!.email }), JSON.stringify(lines),
        o.subtotal, o.discount, o.tax, o.total]);
  }

  /** Voids the order's invoice (kept for the record). A no-op when the order has none. */
  async voidWith(c: pg.PoolClient, orderId: string): Promise<void> {
    await c.query("UPDATE invoices SET status = 'VOID', voided_at = now() WHERE order_id = $1 AND status = 'ISSUED'", [orderId]);
  }

  async get(id: string): Promise<Invoice | undefined> {
    const { rows } = await this.pool.query<Invoice>(`${SELECT} WHERE i.id = $1`, [id]);
    return rows[0];
  }

  async list(f: { status?: InvoiceStatus; orderId?: string; year?: number; limit?: number } = {}): Promise<Invoice[]> {
    const values: unknown[] = [];
    const conds: string[] = [];
    if (f.status) { values.push(f.status); conds.push(`i.status = $${values.length}`); }
    if (f.orderId) { values.push(f.orderId); conds.push(`i.order_id = $${values.length}`); }
    if (f.year) { values.push(f.year); conds.push(`i.number LIKE 'INV-' || $${values.length}::text || '-%'`); }
    values.push(Math.min(f.limit ?? 200, 500));
    const { rows } = await this.pool.query<Invoice>(`${SELECT} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY i.number DESC LIMIT $${values.length}`, values);
    return rows;
  }
}
