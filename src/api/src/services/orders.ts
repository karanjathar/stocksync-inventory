import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Order, OrderChannel, OrderItem, OrderStatus, PaymentMethod } from '../domain/types.js';
import type { EventBus } from '../realtime/bus.js';
import type { SettingsService } from './settings.js';
import type { StockService } from './stock.js';

/** Abuse guard: a customer can have at most this many PENDING orders (chat, web). Staff-entered orders are exempt. */
export const MAX_OPEN_ORDERS = 15;

export interface NewOrder {
  customerId: string;
  channel: OrderChannel;
  items: { productId: string; quantity: number }[];
  notes?: string;
  warehouseId?: string | null;
  paymentMethod?: PaymentMethod;
}

export type OrderStatusObserver = (order: Order, previous: OrderStatus | null) => void | Promise<void>;

const ORDER_SELECT = `
  SELECT o.id, o.number, o.customer_id AS "customerId", c.name AS "customerName", o.channel, o.status,
         o.warehouse_id AS "warehouseId", o.total_cents AS "totalCents", o.notes,
         o.created_at AS "createdAt", o.updated_at AS "updatedAt",
         o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus", o.public_token AS "publicToken"
  FROM orders o JOIN customers c ON c.id = o.customer_id`;

type OrderRow = Omit<Order, 'items'>;

export class OrdersService {
  private readonly observers: OrderStatusObserver[] = [];

  constructor(
    private readonly pool: pg.Pool,
    private readonly stock: StockService,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  onStatusChange(o: OrderStatusObserver): void { this.observers.push(o); }

  async create(input: NewOrder): Promise<Order> {
    const merged = new Map<string, number>();
    for (const i of input.items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
    if (!merged.size) throw new ValidationError('Order must contain at least one item');

    const id = await withTx(this.pool, async (c) => {
      // Row lock: concurrent requests for one customer queue up here, so the cap below cannot be raced past.
      const cust = await c.query('SELECT 1 FROM customers WHERE id = $1 FOR NO KEY UPDATE', [input.customerId]);
      if (!cust.rowCount) throw new NotFoundError('Customer');
      if (input.channel !== 'manual') {
        const open = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE customer_id = $1 AND status = 'PENDING'", [input.customerId]);
        if (open.rows[0]!.n >= MAX_OPEN_ORDERS) {
          throw new AppError(429, 'TOO_MANY_OPEN_ORDERS', `Too many open orders (${MAX_OPEN_ORDERS}). Please wait until some are confirmed or cancelled, or contact us.`);
        }
      }
      const { rows: products } = await c.query<{ id: string; sku: string; priceCents: number; isActive: boolean }>(
        'SELECT id, sku, price_cents AS "priceCents", is_active AS "isActive" FROM products WHERE id = ANY($1::uuid[])', [[...merged.keys()]]);
      if (products.length !== merged.size) throw new NotFoundError('Product');
      const inactive = products.filter((p) => !p.isActive);
      if (inactive.length) throw new ConflictError(`Product not available: ${inactive.map((p) => p.sku).join(', ')}`);
      const total = products.reduce((sum, p) => sum + p.priceCents * merged.get(p.id)!, 0);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (customer_id, channel, status, warehouse_id, total_cents, notes, payment_method)
         VALUES ($1, $2, 'PENDING', $3, $4, $5, $6) RETURNING id`,
        [input.customerId, input.channel, input.warehouseId ?? null, total, input.notes ?? '', input.paymentMethod ?? 'COD']);
      const orderId = rows[0]!.id;
      for (const p of products) {
        await c.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)',
          [orderId, p.id, merged.get(p.id), p.priceCents]);
      }
      return orderId;
    });
    const order = (await this.get(id))!;
    this.events.publish({ type: 'order.created', orderId: order.id, number: order.number, status: order.status });
    await this.emit(order, null);
    return order;
  }

  async confirm(id: string, warehouseId: string | undefined, userId: string | null): Promise<Order> {
    const defaults = await this.settings.get();
    const { changes } = await withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      if (row.status !== 'PENDING') throw new ConflictError(`Only PENDING orders can be confirmed (order is ${row.status})`);
      const wh = warehouseId ?? row.warehouseId ?? defaults.defaultWarehouseId;
      if (!wh) throw new ValidationError('A warehouse is required to confirm (set a default warehouse in Settings)');
      const items = await this.items(c, id);
      const changes = await this.stock.applyMany(c, items.map((i) => ({
        productId: i.productId, warehouseId: wh, delta: -i.quantity, type: 'OUT' as const,
        reason: `Order #${row.number}`, reference: `ORDER-${row.number}`, userId,
      })));
      await c.query("UPDATE orders SET status = 'CONFIRMED', warehouse_id = $2, updated_at = now() WHERE id = $1", [id, wh]);
      return { changes };
    });
    await this.stock.notify(changes);
    return this.afterTransition(id, 'PENDING');
  }

  async fulfill(id: string): Promise<Order> {
    await withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      if (row.status !== 'CONFIRMED') throw new ConflictError(`Only CONFIRMED orders can be fulfilled (order is ${row.status})`);
      await c.query("UPDATE orders SET status = 'FULFILLED', updated_at = now() WHERE id = $1", [id]);
    });
    return this.afterTransition(id, 'CONFIRMED');
  }

  async cancel(id: string, userId: string | null): Promise<Order> {
    const { previous, changes } = await withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      if (row.status === 'FULFILLED' || row.status === 'CANCELLED') throw new ConflictError(`Order is already ${row.status}`);
      let changes: Awaited<ReturnType<StockService['applyMany']>> = [];
      if (row.status === 'CONFIRMED' && row.warehouseId) {
        const items = await this.items(c, id);
        changes = await this.stock.applyMany(c, items.map((i) => ({
          productId: i.productId, warehouseId: row.warehouseId!, delta: i.quantity, type: 'IN' as const,
          reason: `Order #${row.number} cancelled`, reference: `ORDER-${row.number}`, userId,
        })));
      }
      await c.query("UPDATE orders SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [id]);
      return { previous: row.status, changes };
    });
    await this.stock.notify(changes);
    return this.afterTransition(id, previous);
  }

  async get(id: string): Promise<Order | undefined> {
    const { rows } = await this.pool.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1`, [id]);
    return rows[0] ? { ...rows[0], items: await this.items(this.pool, id) } : undefined;
  }

  /** Lookup by the unguessable public token (shop order-status page). */
  async getByPublicToken(token: string): Promise<Order | undefined> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM orders WHERE public_token = $1', [token]);
    return rows[0] ? this.get(rows[0].id) : undefined;
  }

  async getByNumber(n: number): Promise<Order | undefined> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM orders WHERE number = $1', [n]);
    return rows[0] ? this.get(rows[0].id) : undefined;
  }

  async list(f: { status?: OrderStatus; customerId?: string; limit?: number } = {}): Promise<Order[]> {
    const values: unknown[] = [];
    const conds: string[] = [];
    if (f.status) { values.push(f.status); conds.push(`o.status = $${values.length}`); }
    if (f.customerId) { values.push(f.customerId); conds.push(`o.customer_id = $${values.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    values.push(Math.min(f.limit ?? 200, 500));
    const { rows } = await this.pool.query<OrderRow>(`${ORDER_SELECT} ${where} ORDER BY o.number DESC LIMIT $${values.length}`, values);
    if (!rows.length) return [];
    const { rows: items } = await this.pool.query<OrderItem & { orderId: string }>(
      `SELECT oi.order_id AS "orderId", oi.product_id AS "productId", p.sku, p.name, oi.quantity, oi.unit_price_cents AS "unitPriceCents"
       FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1::uuid[]) ORDER BY p.sku`,
      [rows.map((r) => r.id)]);
    return rows.map((r) => ({ ...r, items: items.filter((i) => i.orderId === r.id).map(({ orderId: _o, ...i }) => i) }));
  }

  private async afterTransition(id: string, previous: OrderStatus): Promise<Order> {
    const order = (await this.get(id))!;
    this.events.publish({ type: 'order.updated', orderId: order.id, number: order.number, status: order.status });
    await this.emit(order, previous);
    return order;
  }

  private async emit(order: Order, previous: OrderStatus | null): Promise<void> {
    for (const o of this.observers) {
      try { await o(order, previous); } catch (err) { this.onError(err); }
    }
  }

  private async lock(c: pg.PoolClient, id: string): Promise<{ status: OrderStatus; number: number; warehouseId: string | null }> {
    const { rows } = await c.query<{ status: OrderStatus; number: number; warehouseId: string | null }>(
      'SELECT status, number, warehouse_id AS "warehouseId" FROM orders WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new NotFoundError('Order');
    return rows[0];
  }

  private async items(c: Pick<pg.Pool, 'query'>, orderId: string): Promise<OrderItem[]> {
    const { rows } = await c.query<OrderItem>(
      `SELECT oi.product_id AS "productId", p.sku, p.name, oi.quantity, oi.unit_price_cents AS "unitPriceCents"
       FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY p.sku`, [orderId]);
    return rows;
  }
}
