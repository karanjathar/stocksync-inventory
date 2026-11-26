import type { Logger } from 'pino';
import type { ProductsRepo } from '../repositories/products.js';
import type { EventBus } from '../realtime/bus.js';
import type { Messenger } from './messenger.js';
import type { SettingsService } from './settings.js';
import type { StockChange } from './stock.js';

export class AlertService {
  constructor(
    private readonly products: ProductsRepo,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly messenger: Messenger,
    private readonly logger: Logger,
  ) {}

  /** Stock observer: alerts only when a product's total crosses down through its reorder level. */
  async onStockChanged(changes: StockChange[]): Promise<void> {
    const net = new Map<string, number>();
    for (const c of changes) net.set(c.productId, (net.get(c.productId) ?? 0) + c.delta);
    for (const [productId, delta] of net) {
      if (delta >= 0) continue;
      const p = await this.products.get(productId);
      if (!p || p.reorderLevel <= 0) continue;
      const before = p.totalQuantity - delta;
      if (!(before > p.reorderLevel && p.totalQuantity <= p.reorderLevel)) continue;

      this.events.publish({ type: 'stock.low', productId: p.id, sku: p.sku, name: p.name, totalQuantity: p.totalQuantity, reorderLevel: p.reorderLevel });
      const { alertRecipients, businessName } = await this.settings.get();
      const text = `⚠️ ${businessName} low stock: ${p.name} (${p.sku}) is at ${p.totalQuantity} ${p.unit} (reorder level ${p.reorderLevel}).`;
      for (const r of alertRecipients) {
        try {
          await this.messenger.send(r.channel, r.to, text, { event: 'low_stock_alert',
            params: { productName: p.name, quantity: String(p.totalQuantity), businessName } });
        } catch (err) {
          this.logger.warn({ err, channel: r.channel }, 'low-stock alert delivery failed');
        }
      }
    }
  }
}
