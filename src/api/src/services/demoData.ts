import type { Queryable } from '../db/pool.js';
import type { ProductsRepo } from '../repositories/products.js';
import type { StockService } from './stock.js';

interface DemoIds { productIds: string[]; warehouseId: string; categoryId: string | null; supplierId: string | null; customerId: string | null }
export interface OnboardingStep { id: 'profile' | 'warehouse' | 'product' | 'whatsapp' | 'gst'; done: boolean; optional: boolean }
export interface OnboardingState { steps: OnboardingStep[]; dismissed: boolean; demo: boolean; complete: boolean }

export const DEMO_PREFIX = '[Demo] ';
/** Prices are integer minor units. One item is deliberately low on stock so the alerts and reorder screens have something to show. */
const SAMPLE = [
  { sku: 'DEMO-TEE', name: 'Cotton T-Shirt', priceCents: 49900, qty: 40, reorder: 10 },
  { sku: 'DEMO-MUG', name: 'Ceramic Mug', priceCents: 24900, qty: 25, reorder: 8 },
  { sku: 'DEMO-NOTE', name: 'Notebook A5', priceCents: 9900, qty: 120, reorder: 30 },
  { sku: 'DEMO-BOTTLE', name: 'Steel Water Bottle', priceCents: 34900, qty: 3, reorder: 10 },
  { sku: 'DEMO-TOTE', name: 'Canvas Tote Bag', priceCents: 19900, qty: 60, reorder: 15 },
  { sku: 'DEMO-STICK', name: 'Sticker Pack', priceCents: 4900, qty: 200, reorder: 50 },
] as const;

/** Per-business first-run help: a checklist computed from the real data, and removable sample data. Both are stored in the business's own settings rows. */
export class OnboardingService {
  constructor(private readonly db: Queryable, private readonly products: ProductsRepo, private readonly stock: StockService,
    private readonly whatsappConfigured: () => Promise<boolean>) {}

  private async read<T>(key: string): Promise<T | undefined> {
    return (await this.db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key])).rows[0]?.value;
  }
  private async write(key: string, value: unknown): Promise<void> {
    await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
  }

  async state(): Promise<OnboardingState> {
    const [profile, warehouses, products, gst, whatsapp, dismissed, demo] = await Promise.all([
      this.read<string>('businessName'),
      this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM warehouses WHERE code <> 'DEMO'"),
      this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM products WHERE sku NOT LIKE 'DEMO-%'"),
      this.read<{ gstin?: string }>('gst'),
      this.whatsappConfigured(),
      this.read<boolean>('onboardingDismissed'),
      this.read<DemoIds>('demoData'),
    ]);
    const steps: OnboardingStep[] = [
      { id: 'profile', done: typeof profile === 'string' && profile.trim() !== '', optional: false },
      { id: 'warehouse', done: (warehouses.rows[0]?.n ?? 0) > 0, optional: false },
      { id: 'product', done: (products.rows[0]?.n ?? 0) > 0, optional: false },
      { id: 'whatsapp', done: whatsapp, optional: false },
      { id: 'gst', done: !!gst?.gstin, optional: true },
    ];
    return { steps, dismissed: dismissed === true, demo: demo !== undefined, complete: steps.every((s) => s.done || s.optional) };
  }

  async dismiss(dismissed: boolean): Promise<OnboardingState> { await this.write('onboardingDismissed', dismissed); return this.state(); }

  /** Idempotent: a second call changes nothing. */
  async addDemo(userId: string | null): Promise<{ created: boolean; products: number }> {
    const existing = await this.read<DemoIds>('demoData');
    if (existing) return { created: false, products: existing.productIds.length };
    const warehouse = (await this.db.query<{ id: string }>("INSERT INTO warehouses (code, name, address) VALUES ('DEMO', $1, '') RETURNING id", [`${DEMO_PREFIX}Main warehouse`])).rows[0]!.id;
    const category = (await this.db.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [`${DEMO_PREFIX}General`])).rows[0]!.id;
    const supplier = (await this.db.query<{ id: string }>("INSERT INTO suppliers (name, email, phone, notes) VALUES ($1, '', '', 'Sample supplier') RETURNING id", [`${DEMO_PREFIX}Sample Supplier`])).rows[0]?.id ?? null;
    const productIds: string[] = [];
    for (const s of SAMPLE) {
      const p = await this.products.create({ sku: s.sku, name: `${DEMO_PREFIX}${s.name}`, priceCents: s.priceCents, reorderLevel: s.reorder, categoryId: category, attributes: { demo: 'true' } });
      await this.stock.receive({ productId: p.id, warehouseId: warehouse, quantity: s.qty, reason: 'Sample data' }, userId);
      productIds.push(p.id);
    }
    await this.write('demoData', { productIds, warehouseId: warehouse, categoryId: category, supplierId: supplier, customerId: null } satisfies DemoIds);
    return { created: true, products: productIds.length };
  }

  /** Deletes the sample records. A sample product that real orders already use is hidden instead of deleted, so history stays intact. */
  async removeDemo(): Promise<{ removed: number; kept: number }> {
    const ids = await this.read<DemoIds>('demoData');
    if (!ids) return { removed: 0, kept: 0 };
    let removed = 0; let kept = 0;
    for (const id of ids.productIds) {
      try { await this.db.query('DELETE FROM products WHERE id = $1', [id]); removed++; } catch (err) {
        if ((err as { code?: string }).code !== '23503') throw err;
        await this.db.query('UPDATE products SET is_active = false, updated_at = now() WHERE id = $1', [id]); kept++;
      }
    }
    for (const [table, id] of [['suppliers', ids.supplierId], ['categories', ids.categoryId], ['warehouses', ids.warehouseId]] as const) {
      if (!id) continue;
      try { await this.db.query(`DELETE FROM ${table} WHERE id = $1`, [id]); } catch (err) { if ((err as { code?: string }).code !== '23503') throw err; } // still referenced: leave it
    }
    await this.db.query("DELETE FROM settings WHERE key = 'demoData'");
    return { removed, kept };
  }
}
