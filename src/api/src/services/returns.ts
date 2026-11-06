import type pg from 'pg';
import type { Logger } from 'pino';
import { withTx } from '../db/tx.js';
import { roundDiv } from '../domain/pricing.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { ChannelName, CreditNote, CreditNoteLine, RefundStatus, SalesReturn } from '../domain/types.js';
import type { Messenger } from './messenger.js';
import { formatMoney } from './money.js';
import type { SettingsService } from './settings.js';
import type { StockService } from './stock.js';

export const formatCreditNoteNumber = (year: number, n: number): string => `CN-${year}-${String(n).padStart(6, '0')}`;

export interface ReturnInput { requestId: string; warehouseId: string; lines: { orderItemId: string; quantity: number }[]; reason?: string }

const CHAT: readonly string[] = ['whatsapp', 'messenger', 'instagram', 'telegram'];
const RETURN_SELECT = `
  SELECT r.id, r.number, r.order_id AS "orderId", o.number AS "orderNumber", r.warehouse_id AS "warehouseId",
         r.credit_subtotal_cents AS "creditSubtotalCents", r.credit_tax_cents AS "creditTaxCents", r.credit_total_cents AS "creditTotalCents",
         r.reason, r.refund_status AS "refundStatus", r.refund_cents AS "refundCents", r.request_id AS "requestId", r.created_at AS "createdAt",
         jsonb_build_object('id', cn.id, 'number', cn.number) AS "creditNote"
  FROM sales_returns r JOIN orders o ON o.id = r.order_id JOIN credit_notes cn ON cn.sales_return_id = r.id`;
const CN_SELECT = `
  SELECT cn.id, cn.number, cn.sales_return_id AS "salesReturnId", cn.order_id AS "orderId", o.number AS "orderNumber", cn.invoice_number AS "invoiceNumber",
         cn.currency, cn.inclusive, cn.seller, cn.customer, cn.lines, cn.reason, cn.subtotal_cents AS "subtotalCents", cn.tax_cents AS "taxCents",
         cn.total_cents AS "totalCents", cn.issued_at AS "issuedAt"
  FROM credit_notes cn JOIN orders o ON o.id = cn.order_id`;

/** Cumulative share of a line value for k of q units. Differences of this are exact: the credits of all parts add up to the whole line. */
const share = (value: number, k: number, q: number): number => Number(roundDiv(BigInt(value) * BigInt(k), BigInt(q)));

type Row = Omit<SalesReturn, 'items'>;

/**
 * Sales returns: goods go back into stock only through StockService, a credit note (immutable) is issued with the tax reversed,
 * and a paid online order gets a refund-due flag for the credit amount that staff clear once they refunded in Razorpay.
 */
export class ReturnsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly stock: StockService,
    private readonly settings: SettingsService,
    private readonly messenger: Messenger,
    private readonly logger: Logger,
  ) {}

  async create(orderId: string, input: ReturnInput, userId: string | null): Promise<{ salesReturn: SalesReturn; created: boolean }> {
    const merged = new Map<string, number>();
    for (const l of input.lines) {
      if (merged.has(l.orderItemId)) throw new ValidationError('Each order line may appear only once per return');
      merged.set(l.orderItemId, l.quantity);
    }
    if (!merged.size) throw new ValidationError('A return needs at least one line');
    const s = await this.settings.get(); // read before the transaction: asking the pool for a second connection inside it can starve the pool

    const out = await withTx(this.pool, async (c) => {
      const { rows: [order] } = await c.query<{ id: string; number: number; status: string; paymentMethod: string; paymentStatus: string; customerId: string; inclusive: boolean }>(
        `SELECT id, number, status, payment_method AS "paymentMethod", payment_status AS "paymentStatus", customer_id AS "customerId", prices_include_tax AS inclusive
         FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!order) throw new NotFoundError('Order');

      const { rows: [prior] } = await c.query<{ id: string; orderId: string; warehouseId: string }>(
        'SELECT id, order_id AS "orderId", warehouse_id AS "warehouseId" FROM sales_returns WHERE request_id = $1', [input.requestId]);
      if (prior) {
        const { rows: had } = await c.query<{ orderItemId: string; quantity: number }>('SELECT order_item_id AS "orderItemId", quantity FROM sales_return_items WHERE sales_return_id = $1', [prior.id]);
        const same = prior.orderId === orderId && prior.warehouseId === input.warehouseId && had.length === merged.size && had.every((h) => merged.get(h.orderItemId) === h.quantity);
        if (!same) throw new ConflictError('This request id was already used for a different return');
        return { id: prior.id, created: false, alert: null as null | { text: string }, changes: [] as Awaited<ReturnType<StockService['applyMany']>> };
      }
      if (order.status !== 'CONFIRMED' && order.status !== 'FULFILLED') throw new ConflictError(`Only confirmed or fulfilled orders can have returns (this one is ${order.status})`);

      if (!(await c.query('SELECT 1 FROM warehouses WHERE id = $1', [input.warehouseId])).rowCount) throw new NotFoundError('Warehouse');

      const { rows: items } = await c.query<{ id: string; productId: string; sku: string; name: string; quantity: number; unitPriceCents: number; taxRateBp: number; taxCents: number; totalCents: number; returned: number }>(
        `SELECT oi.id, oi.product_id AS "productId", p.sku, p.name, oi.quantity, oi.unit_price_cents AS "unitPriceCents", oi.tax_rate_bp AS "taxRateBp",
                oi.tax_cents AS "taxCents", oi.total_cents AS "totalCents",
                COALESCE((SELECT SUM(sri.quantity) FROM sales_return_items sri WHERE sri.order_item_id = oi.id), 0)::int AS returned
         FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`, [orderId]);
      const byId = new Map(items.map((i) => [i.id, i]));
      const credits: { item: (typeof items)[number]; quantity: number; tax: number; total: number }[] = [];
      for (const [orderItemId, quantity] of merged) {
        const item = byId.get(orderItemId);
        if (!item) throw new NotFoundError('Order item');
        const left = item.quantity - item.returned;
        if (quantity > left) throw new ConflictError(`Cannot return ${quantity} of ${item.sku}: only ${left} can still be returned`);
        const total = share(item.totalCents, item.returned + quantity, item.quantity) - share(item.totalCents, item.returned, item.quantity);
        const tax = share(item.taxCents, item.returned + quantity, item.quantity) - share(item.taxCents, item.returned, item.quantity);
        credits.push({ item, quantity, tax, total });
      }
      const creditTotal = credits.reduce((n, x) => n + x.total, 0);
      const creditTax = credits.reduce((n, x) => n + x.tax, 0);

      const { rows: [ret] } = await c.query<{ id: string; number: number }>(
        `INSERT INTO sales_returns (order_id, warehouse_id, credit_subtotal_cents, credit_tax_cents, credit_total_cents, request_id, reason, refund_status, refund_cents, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'NOT_REQUIRED', 0, $8) RETURNING id, number`,
        [orderId, input.warehouseId, creditTotal - creditTax, creditTax, creditTotal, input.requestId, input.reason ?? '', userId]);
      for (const x of credits) {
        await c.query('INSERT INTO sales_return_items (sales_return_id, order_item_id, quantity, credit_tax_cents, credit_total_cents) VALUES ($1, $2, $3, $4, $5)',
          [ret!.id, x.item.id, x.quantity, x.tax, x.total]);
      }
      // Goods back into stock: the only write path is StockService (also verifies the warehouse exists).
      const changes = await this.stock.applyMany(c, credits.map((x) => ({
        productId: x.item.productId, warehouseId: input.warehouseId, delta: x.quantity, type: 'IN' as const,
        reason: `Return #${ret!.number} (order #${order.number})`, reference: `RET-${ret!.number}`, userId,
      })));

      // The credit note repeats the original invoice's seller/customer so both documents agree.
      const { rows: [inv] } = await c.query<{ number: string; seller: unknown; customer: unknown; currency: string; inclusive: boolean }>(
        'SELECT number, seller, customer, currency, inclusive FROM invoices WHERE order_id = $1', [orderId]);
      const { rows: [cust] } = await c.query<{ name: string; phone: string | null; email: string | null }>('SELECT name, phone, email FROM customers WHERE id = $1', [order.customerId]);
      const lines: CreditNoteLine[] = credits.map((x) => ({
        sku: x.item.sku, name: x.item.name, quantity: x.quantity, unitPriceCents: x.item.unitPriceCents, netCents: x.total - x.tax,
        taxRateBp: x.item.taxRateBp, taxCents: x.tax, totalCents: x.total,
      }));
      const { rows: [counter] } = await c.query<{ year: number; last: number }>(
        `INSERT INTO credit_note_counters (year, last) VALUES (extract(year FROM now())::int, 1)
         ON CONFLICT (year) DO UPDATE SET last = credit_note_counters.last + 1 RETURNING year, last`);
      await c.query(
        `INSERT INTO credit_notes (sales_return_id, number, order_id, invoice_number, currency, inclusive, seller, customer, lines, reason, subtotal_cents, tax_cents, total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [ret!.id, formatCreditNoteNumber(counter!.year, counter!.last), orderId, inv?.number ?? null, inv?.currency ?? s.currency, inv?.inclusive ?? order.inclusive,
          JSON.stringify(inv?.seller ?? { businessName: s.businessName, taxId: s.taxId, address: s.businessAddress, whatsappNumber: s.whatsappNumber }),
          JSON.stringify(inv?.customer ?? cust), JSON.stringify(lines), input.reason ?? '', creditTotal - creditTax, creditTax, creditTotal]);

      // A paid online order owes the customer the credit: flag it for staff (the T58 manual-refund flow, per return).
      let alert: null | { text: string } = null;
      if (order.paymentMethod === 'ONLINE' && order.paymentStatus === 'PAID' && creditTotal > 0) {
        await c.query("UPDATE sales_returns SET refund_status = 'REFUND_DUE', refund_cents = $2 WHERE id = $1", [ret!.id, creditTotal]);
        alert = { text: `⚠️ Return #${ret!.number} on paid order #${order.number}: refund ${formatMoney(creditTotal, s.currency)} to the customer in Razorpay, then press Mark refunded.` };
      }
      return { id: ret!.id, created: true, alert, changes };
    });

    await this.stock.notify(out.changes);
    if (out.alert) await this.alertStaff(out.alert.text);
    return { salesReturn: (await this.get(out.id))!, created: out.created };
  }

  /** Staff refunded the customer in Razorpay: clear the flag exactly once and tell the customer. */
  async markRefunded(id: string): Promise<SalesReturn> {
    const { rows: [moved] } = await this.pool.query<{ orderId: string; refundCents: number }>(
      "UPDATE sales_returns SET refund_status = 'REFUNDED' WHERE id = $1 AND refund_status = 'REFUND_DUE' RETURNING order_id AS \"orderId\", refund_cents AS \"refundCents\"", [id]);
    const ret = await this.get(id);
    if (!ret) throw new NotFoundError('Return');
    if (!moved) throw new ConflictError('Only returns awaiting a refund can be marked as refunded');
    await this.tellCustomer(moved.orderId, (money) => `💸 Your refund of ${money(moved.refundCents)} for order #${ret.orderNumber} has been issued. It can take a few days to show up in your account.`);
    return ret;
  }

  async get(id: string): Promise<SalesReturn | undefined> {
    const { rows } = await this.pool.query<Row>(`${RETURN_SELECT} WHERE r.id = $1`, [id]);
    return rows[0] ? (await this.withItems([rows[0]]))[0] : undefined;
  }

  async list(f: { orderId?: string; refundStatus?: RefundStatus; limit?: number } = {}): Promise<SalesReturn[]> {
    const values: unknown[] = [];
    const conds: string[] = [];
    if (f.orderId) { values.push(f.orderId); conds.push(`r.order_id = $${values.length}`); }
    if (f.refundStatus) { values.push(f.refundStatus); conds.push(`r.refund_status = $${values.length}`); }
    values.push(Math.min(f.limit ?? 200, 500));
    const { rows } = await this.pool.query<Row>(`${RETURN_SELECT} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY r.number DESC LIMIT $${values.length}`, values);
    return this.withItems(rows);
  }

  async creditNote(id: string): Promise<CreditNote | undefined> {
    const { rows } = await this.pool.query<CreditNote>(`${CN_SELECT} WHERE cn.id = $1`, [id]);
    return rows[0];
  }

  async creditNotes(limit = 200): Promise<CreditNote[]> {
    const { rows } = await this.pool.query<CreditNote>(`${CN_SELECT} ORDER BY cn.number DESC LIMIT $1`, [Math.min(limit, 500)]);
    return rows;
  }

  private async withItems(rows: Row[]): Promise<SalesReturn[]> {
    if (!rows.length) return [];
    const { rows: items } = await this.pool.query<SalesReturn['items'][number] & { returnId: string }>(
      `SELECT sri.sales_return_id AS "returnId", sri.order_item_id AS "orderItemId", p.sku, p.name, sri.quantity,
              sri.credit_tax_cents AS "creditTaxCents", sri.credit_total_cents AS "creditTotalCents"
       FROM sales_return_items sri JOIN order_items oi ON oi.id = sri.order_item_id JOIN products p ON p.id = oi.product_id
       WHERE sri.sales_return_id = ANY($1::uuid[]) ORDER BY p.sku`, [rows.map((r) => r.id)]);
    return rows.map((r) => ({ ...r, items: items.filter((i) => i.returnId === r.id).map(({ returnId: _r, ...i }) => i) }));
  }

  private async tellCustomer(orderId: string, text: (money: (c: number) => string) => string): Promise<void> {
    const { rows: [cust] } = await this.pool.query<{ channel: string; channelUserId: string | null }>(
      'SELECT c.channel, c.channel_user_id AS "channelUserId" FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1', [orderId]);
    if (!cust?.channelUserId || !CHAT.includes(cust.channel)) return;
    const currency = (await this.settings.get()).currency;
    await this.messenger.send(cust.channel as ChannelName, cust.channelUserId, text((cents) => formatMoney(cents, currency)))
      .catch((err: unknown) => this.logger.warn({ err: String(err) }, 'refund message to customer failed'));
  }

  private async alertStaff(text: string): Promise<void> {
    const { alertRecipients } = await this.settings.get();
    for (const r of alertRecipients) {
      await this.messenger.send(r.channel, r.to, text).catch((err: unknown) => this.logger.warn({ err: String(err), channel: r.channel }, 'staff return alert failed'));
    }
  }
}
