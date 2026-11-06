import type { Queryable } from '../db/pool.js';
import type { Product } from '../domain/types.js';
import { escapeLike } from './simple.js';

export const PRODUCT_SELECT = `
  SELECT p.id, p.sku, p.name, p.description, p.category_id AS "categoryId", p.unit,
         p.price_cents AS "priceCents", p.reorder_level AS "reorderLevel", p.reorder_quantity AS "reorderQuantity",
         p.preferred_supplier_id AS "preferredSupplierId", p.image_url AS "imageUrl",
         p.attributes, p.is_active AS "isActive", COALESCE(s.total, 0)::int AS "totalQuantity",
         p.created_at AS "createdAt", p.updated_at AS "updatedAt"
  FROM products p
  LEFT JOIN (SELECT product_id, SUM(quantity) AS total FROM stock_levels GROUP BY product_id) s ON s.product_id = p.id`;

export interface ProductFilter { search?: string; categoryId?: string; lowStock?: boolean; activeOnly?: boolean; limit?: number }
export type ProductInput = Partial<Pick<Product, 'sku' | 'name' | 'description' | 'categoryId' | 'unit' | 'priceCents' |
  'reorderLevel' | 'reorderQuantity' | 'preferredSupplierId' | 'imageUrl' | 'attributes' | 'isActive'>>;

const COLUMN: Record<keyof ProductInput, string> = {
  sku: 'sku', name: 'name', description: 'description', categoryId: 'category_id', unit: 'unit',
  priceCents: 'price_cents', reorderLevel: 'reorder_level', reorderQuantity: 'reorder_quantity',
  preferredSupplierId: 'preferred_supplier_id', imageUrl: 'image_url', attributes: 'attributes', isActive: 'is_active',
};

/** Low stock = tracked (reorder level > 0) and total quantity at or below the reorder level. */
export const LOW_STOCK_SQL = 'p.reorder_level > 0 AND COALESCE(s.total, 0) <= p.reorder_level';

export class ProductsRepo {
  constructor(private readonly db: Queryable) {}

  async list(f: ProductFilter = {}): Promise<Product[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (f.search) {
      values.push(`%${escapeLike(f.search)}%`);
      where.push(`(p.sku ILIKE $${values.length} OR p.name ILIKE $${values.length} OR p.description ILIKE $${values.length})`);
    }
    if (f.categoryId) { values.push(f.categoryId); where.push(`p.category_id = $${values.length}`); }
    if (f.lowStock) where.push(LOW_STOCK_SQL);
    if (f.activeOnly) where.push('p.is_active');
    values.push(Math.min(f.limit ?? 500, 1000));
    const sql = `${PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.name LIMIT $${values.length}`;
    const { rows } = await this.db.query<Product>(sql, values);
    return rows;
  }

  async get(id: string): Promise<Product | undefined> {
    const { rows } = await this.db.query<Product>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
    return rows[0];
  }

  async getBySku(sku: string): Promise<Product | undefined> {
    const { rows } = await this.db.query<Product>(`${PRODUCT_SELECT} WHERE p.sku = $1`, [sku.toUpperCase()]);
    return rows[0];
  }

  async create(input: ProductInput & { sku: string; name: string; priceCents: number }): Promise<Product> {
    const entries = this.entries(input);
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO products (${entries.map(([c]) => c).join(', ')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      entries.map(([, v]) => v),
    );
    return (await this.get(rows[0]!.id))!;
  }

  async update(id: string, patch: ProductInput): Promise<Product | undefined> {
    const entries = this.entries(patch);
    const sets = entries.map(([c], i) => `${c} = $${i + 2}`);
    sets.push('updated_at = now()');
    const { rowCount } = await this.db.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
    return rowCount ? this.get(id) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM products WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private entries(input: ProductInput): [string, unknown][] {
    return (Object.keys(COLUMN) as (keyof ProductInput)[])
      .filter((k) => input[k] !== undefined)
      .map((k) => [COLUMN[k], k === 'attributes' ? JSON.stringify(input[k]) : input[k]]);
  }
}
