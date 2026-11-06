import type { InboundMessage, Order } from '../domain/types.js';
import type { BotReply } from '../channels/reply.js';
import { AppError } from '../domain/errors.js';
import type { CustomersRepo } from '../repositories/customers.js';
import type { ProductsRepo } from '../repositories/products.js';
import type { OrdersService } from './orders.js';
import type { SettingsService } from './settings.js';

import { formatMoney } from './money.js';
import type { ChatFlow } from './chatFlow.js';

export { formatMoney };

/** Chat command engine shared by every channel. Returns the reply text. */
export class BotService {
  constructor(
    private readonly products: ProductsRepo,
    private readonly orders: OrdersService,
    private readonly customers: CustomersRepo,
    private readonly settings: SettingsService,
    private readonly flow?: ChatFlow,
  ) {}

  /** Maps tapped actions (docs/3_SCHEMAS.md §3.12) to the command they stand for. */
  private static readonly ACTION_COMMANDS: Record<string, string> = { catalog: 'catalog', menu: 'help', help: 'help' };

  async handle(msg: InboundMessage): Promise<BotReply> {
    if (msg.action !== undefined && this.flow) {
      const flowReply = await this.flow.handle(msg);
      if (flowReply) return flowReply;
    }
    const command = msg.action !== undefined ? BotService.ACTION_COMMANDS[msg.action] ?? 'help' : msg.text;
    const text = await this.handleText({ ...msg, text: command });
    const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const known = ['stock', 'price', 'catalog', 'menu', 'order', 'status'];
    const isWelcome = !known.includes(first);
    const multiLineOrder = command.split('\n').filter((l) => l.trim()).length > 1 && /^order\s/im.test(command);
    if (!isWelcome || multiLineOrder) return { text };
    // FR-R2-7: the welcome carries the tap-to-order menu; text commands stay documented in the text.
    const buttons = this.flow?.menu('').buttons ?? [{ id: 'catalog', title: '🛍 Browse' }];
    return { text, buttons };
  }

  private async handleText(msg: InboundMessage): Promise<string> {
    const s = await this.settings.get();
    const money = (c: number) => formatMoney(c, s.currency);

    // Multi-line cart messages (e.g. from the shop's "Order on WhatsApp" button): one order for all "order" lines.
    const lines = msg.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const orderLines = lines.filter((l) => /^order\s/i.test(l));
    if (lines.length > 1 && orderLines.length > 0) {
      return this.placeOrder(msg, orderLines.map((l) => l.split(/\s+/).slice(1)), money);
    }

    const [cmd = '', ...args] = msg.text.trim().split(/\s+/);

    switch (cmd.toLowerCase()) {
      case 'stock': {
        const p = args[0] ? await this.products.getBySku(args[0]) : undefined;
        if (!p || !p.isActive) return this.unknownSku(args[0]);
        return `${p.name} (${p.sku}): ${p.totalQuantity} ${p.unit} available.`;
      }
      case 'price': {
        const p = args[0] ? await this.products.getBySku(args[0]) : undefined;
        if (!p || !p.isActive) return this.unknownSku(args[0]);
        return `${p.name} (${p.sku}): ${money(p.priceCents)} per ${p.unit}.`;
      }
      case 'catalog':
      case 'menu': {
        const list = (await this.products.list({ activeOnly: true, limit: 200 })).filter((p) => p.totalQuantity > 0).slice(0, 10);
        if (!list.length) return 'Our catalog is being restocked. Please check back soon!';
        return [`${s.businessName} catalog:`, ...list.map((p) => `• ${p.sku} — ${p.name} — ${money(p.priceCents)}`),
          '', 'Reply "order <SKU> <qty>" to order.'].join('\n');
      }
      case 'order':
        return this.placeOrder(msg, [args], money);
      case 'status': {
        const n = Number(args[0]?.replace('#', ''));
        const order = Number.isInteger(n) && n > 0 ? await this.orders.getByNumber(n) : undefined;
        const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
        if (!order || order.customerId !== customer.id) return `Sorry, we couldn't find order ${(args[0] ?? '').slice(0, 20)} for you.`;
        return describeOrder(order, money);
      }
      default:
        return [
          `👋 Welcome to ${s.businessName}! You can send:`,
          '• catalog — see what is in stock',
          '• stock <SKU> — check availability',
          '• price <SKU> — check the price',
          '• order <SKU> <qty> — place an order',
          '• status <order#> — track your order',
        ].join('\n');
    }
  }

  private async placeOrder(msg: InboundMessage, lines: string[][], money: (c: number) => string): Promise<string> {
    const usage = 'To order, send: order <SKU> <qty>  (e.g. "order TEE 2")';
    const items: { productId: string; quantity: number; label: string }[] = [];
    for (const [sku, rawQty] of lines.slice(0, 20)) {
      const qty = Number(rawQty);
      if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 1000) return usage;
      const p = await this.products.getBySku(sku);
      if (!p || !p.isActive) return this.unknownSku(sku);
      if (p.totalQuantity < qty) return `Sorry, we only have ${p.totalQuantity} ${p.unit} of ${p.name} right now.`;
      items.push({ productId: p.id, quantity: qty, label: `${qty} × ${p.name}` });
    }
    if (!items.length) return usage;
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    try {
      const order = await this.orders.create({
        customerId: customer.id, channel: msg.channel, items: items.map(({ productId, quantity }) => ({ productId, quantity })),
      });
      return `✅ Order #${order.number} received: ${items.map((i) => i.label).join(', ')} = ${money(order.totalCents)}. We'll confirm shortly. Reply "status ${order.number}" any time.`;
    } catch (err) {
      if (err instanceof AppError) return `Sorry, we couldn't place that order: ${err.message}`;
      throw err;
    }
  }

  private unknownSku(sku: string | undefined): string {
    return `Sorry, we couldn't find a product with SKU "${(sku ?? '').slice(0, 40)}". Send "catalog" to see our products.`;
  }
}

export function describeOrder(order: Order, money: (c: number) => string): string {
  const lines = order.items.map((i) => `${i.quantity} × ${i.name}`).join(', ');
  return `Order #${order.number} is ${order.status}: ${lines} — total ${money(order.totalCents)}.`;
}
