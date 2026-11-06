import type { ChannelName, Order, OrderStatus } from '../domain/types.js';
import type { CustomersRepo } from '../repositories/customers.js';
import { formatMoney } from './money.js';
import type { Messenger } from './messenger.js';
import type { SettingsService } from './settings.js';

const CHAT_CHANNELS: readonly string[] = ['whatsapp', 'messenger', 'instagram', 'telegram'];

const TEMPLATES: Partial<Record<OrderStatus, (o: Order, total: string, shop: string) => string>> = {
  CONFIRMED: (o, total, shop) => (o.paymentStatus === 'PAID'
    ? `✅ ${shop}: payment of ${total} received — your order #${o.number} is confirmed and being prepared.`
    : `✅ ${shop}: your order #${o.number} (${total}) is confirmed and being prepared.`),
  FULFILLED: (o, _t, shop) => `📦 ${shop}: your order #${o.number} has been fulfilled. Thank you for shopping with us!`,
  CANCELLED: (o, total, shop) => (o.paymentStatus === 'PAID'
    ? `❌ ${shop}: your order #${o.number} has been cancelled. Your payment of ${total} will be refunded.`
    : `❌ ${shop}: your order #${o.number} has been cancelled. Reply "help" if you have questions.`),
};

/** Order observer: tells chat customers when their order changes status. */
export class OrderNotifier {
  constructor(
    private readonly customers: CustomersRepo,
    private readonly settings: SettingsService,
    private readonly messenger: Messenger,
  ) {}

  async onStatusChange(order: Order, previous: OrderStatus | null): Promise<void> {
    if (previous === null || !CHAT_CHANNELS.includes(order.channel)) return;
    const template = TEMPLATES[order.status];
    if (!template) return;
    const customer = await this.customers.get(order.customerId);
    if (!customer?.channelUserId) return;
    const s = await this.settings.get();
    await this.messenger.send(order.channel as ChannelName, customer.channelUserId, template(order, formatMoney(order.totalCents, s.currency), s.businessName));
  }
}
