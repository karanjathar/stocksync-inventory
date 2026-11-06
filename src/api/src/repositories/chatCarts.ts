import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';

export interface CartItem { productId: string; quantity: number }
export interface CartLine { productId: string; sku: string; name: string; unit: string; unitPriceCents: number; quantity: number; available: number }
export interface CartView { lines: CartLine[]; totalCents: number; adjusted: boolean }

interface ProductRow { id: string; sku: string; name: string; unit: string; priceCents: number; isActive: boolean; available: number }

/** One persisted cart per chat customer (docs/3_SCHEMAS.md §3.6, D-006). Prices/stock are always read live. */
export class ChatCartsRepo {
  constructor(private readonly pool: pg.Pool) {}

  /** Current cart, priced live; inactive/deleted products are dropped and quantities re-capped (persisted). */
  async get(customerId: string): Promise<CartView> {
    return withTx(this.pool, async (c) => {
      const view = await this.view(c, await this.lock(c, customerId));
      if (view.adjusted) await this.save(c, customerId, view.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })));
      return view;
    });
  }

  /**
   * Atomically removes and returns the cart (checkout). Concurrent callers serialise on the row:
   * exactly one receives the items, the others get an empty cart — so one cart can never become two orders.
   */
  async take(customerId: string): Promise<CartView> {
    return withTx(this.pool, async (c) => {
      const { rows } = await c.query<{ items: CartItem[] }>('DELETE FROM chat_carts WHERE customer_id = $1 RETURNING items', [customerId]);
      return this.view(c, rows[0]?.items ?? []);
    });
  }

  /** Puts taken items back (e.g. order creation failed), merged with anything added meanwhile. */
  async restore(customerId: string, items: CartItem[]): Promise<void> {
    await withTx(this.pool, async (c) => {
      const current = await this.lock(c, customerId);
      const merged = new Map(current.map((i) => [i.productId, i.quantity]));
      for (const i of items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
      await this.save(c, customerId, [...merged].map(([productId, quantity]) => ({ productId, quantity })));
    });
  }

  private async view(c: pg.PoolClient, items: CartItem[]): Promise<CartView> {
    const products = await this.products(c, items.map((i) => i.productId));
    const lines: CartLine[] = [];
    let adjusted = false;
    for (const item of items) {
      const p = products.get(item.productId);
      const quantity = p && p.isActive ? Math.min(item.quantity, p.available) : 0;
      if (quantity !== item.quantity) adjusted = true;
      if (!p || quantity <= 0) continue;
      lines.push({ productId: p.id, sku: p.sku, name: p.name, unit: p.unit, unitPriceCents: p.priceCents, quantity, available: p.available });
    }
    return { lines, totalCents: lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0), adjusted };
  }

  /** Adds up to `quantity`, capped at available stock. */
  async add(customerId: string, productId: string, quantity: number): Promise<{ added: number; capped: boolean }> {
    return withTx(this.pool, async (c) => {
      const items = await this.lock(c, customerId);
      const p = (await this.products(c, [productId])).get(productId);
      if (!p) throw new NotFoundError('Product');
      if (!p.isActive || p.available <= 0) throw new ConflictError(`${p.name} is not available right now`);
      const current = items.find((i) => i.productId === productId)?.quantity ?? 0;
      const next = Math.min(current + quantity, p.available);
      const updated = current === 0
        ? [...items, { productId, quantity: next }]
        : items.map((i) => (i.productId === productId ? { ...i, quantity: next } : i));
      await this.save(c, customerId, updated);
      return { added: Math.max(0, next - current), capped: next < current + quantity };
    });
  }

  /** Sets an exact quantity (0 removes the line). */
  async set(customerId: string, productId: string, quantity: number): Promise<void> {
    await withTx(this.pool, async (c) => {
      const items = (await this.lock(c, customerId)).filter((i) => i.productId !== productId);
      if (quantity > 0) items.push({ productId, quantity });
      await this.save(c, customerId, items);
    });
  }

  async clear(customerId: string): Promise<void> {
    await this.pool.query('DELETE FROM chat_carts WHERE customer_id = $1', [customerId]);
  }

  private async lock(c: pg.PoolClient, customerId: string): Promise<CartItem[]> {
    await c.query('INSERT INTO chat_carts (customer_id) VALUES ($1) ON CONFLICT DO NOTHING', [customerId]);
    const { rows } = await c.query<{ items: CartItem[] }>('SELECT items FROM chat_carts WHERE customer_id = $1 FOR UPDATE', [customerId]);
    return rows[0]?.items ?? [];
  }

  private async save(c: pg.PoolClient, customerId: string, items: CartItem[]): Promise<void> {
    await c.query('UPDATE chat_carts SET items = $2, updated_at = now() WHERE customer_id = $1', [customerId, JSON.stringify(items)]);
  }

  private async products(c: pg.PoolClient, ids: string[]): Promise<Map<string, ProductRow>> {
    if (!ids.length) return new Map();
    const { rows } = await c.query<ProductRow>(
      `SELECT p.id, p.sku, p.name, p.unit, p.price_cents AS "priceCents", p.is_active AS "isActive",
              COALESCE((SELECT SUM(quantity) FROM stock_levels s WHERE s.product_id = p.id), 0)::int AS available
       FROM products p WHERE p.id = ANY($1::uuid[])`, [ids]);
    return new Map(rows.map((r) => [r.id, r]));
  }
}
