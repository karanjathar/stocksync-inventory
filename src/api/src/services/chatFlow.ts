import type { BotReply, ReplyListRow } from '../channels/reply.js';
import { AppError } from '../domain/errors.js';
import type { InboundMessage, Order, PaymentMethod, Product } from '../domain/types.js';
import type { OrdersService } from './orders.js';
import type { ChatCartsRepo } from '../repositories/chatCarts.js';
import type { CustomersRepo } from '../repositories/customers.js';
import type { ProductsRepo } from '../repositories/products.js';
import type { SimpleRepo } from '../repositories/simple.js';
import type { Category } from '../domain/types.js';
import { formatMoney } from './money.js';
import type { SettingsService } from './settings.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGE = 9;
const QTY_CHOICES = [1, 2, 3, 4, 5, 10];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Payment port for checkout. Phase 6 default: cash on delivery only; Razorpay plugs in via setPaymentOptions (T35/T37). */
export interface PaymentOptions {
  available(): Promise<{ online: boolean; cod: boolean }>;
  /** Reply for a freshly created ONLINE order (e.g. a pay-link button). */
  onlineCheckout(order: Order, msg: InboundMessage): Promise<BotReply>;
  /** Reply with a (re)sent pay link for an existing unpaid ONLINE order. */
  resendLink(order: Order, msg: InboundMessage): Promise<BotReply>;
}
const CASH_ONLY: PaymentOptions = {
  available: async () => ({ online: false, cod: true }),
  onlineCheckout: async (order) => ({ text: `Order #${order.number} created. We'll send your payment link shortly.` }),
  resendLink: async () => ({ text: 'Online payment is not available right now.' }),
};

/** Tap-to-order conversation (docs/3_SCHEMAS.md §3.12). Returns undefined for actions it doesn't own. */
export class ChatFlow {
  constructor(
    private readonly products: ProductsRepo,
    private readonly categories: SimpleRepo<Category>,
    private readonly customers: CustomersRepo,
    private readonly carts: ChatCartsRepo,
    private readonly settings: SettingsService,
    private readonly orders: OrdersService,
  ) {}

  private payments: PaymentOptions = CASH_ONLY;

  setPaymentOptions(options: PaymentOptions | undefined): void {
    this.payments = options ?? CASH_ONLY;
  }

  async handle(msg: InboundMessage): Promise<BotReply | undefined> {
    const action = msg.action ?? '';
    const s = await this.settings.get();
    const money = (c: number) => formatMoney(c, s.currency);
    try {
      if (action === 'menu') return this.menu(s.businessName);
      if (action === 'catalog') return await this.catalog();
      let m = new RegExp(`^cat:(${UUID}|all):(-?\\d{1,4})$`).exec(action);
      if (m) return await this.category(m[1]!, Math.max(0, Number(m[2])), money);
      m = new RegExp(`^prod:(${UUID})$`).exec(action);
      if (m) return await this.product(m[1]!, money);
      m = new RegExp(`^qty:(${UUID}):(\\d{1,3})$`).exec(action);
      if (m) return await this.addToCart(msg, m[1]!, Number(m[2]), money);
      if (action === 'cart') return await this.showCart(msg, money);
      if (action === 'cart:clear') return await this.clearCart(msg);
      if (action === 'checkout') return await this.checkout(msg, money);
      if (action === 'pay:cod') return await this.placeOrder(msg, 'COD', money);
      if (action === 'pay:online') return await this.placeOrder(msg, 'ONLINE', money);
      if (action === 'orders') return await this.myOrders(msg, money);
      m = /^paylink:(\d{1,9})$/.exec(action);
      if (m) return await this.payLink(msg, Number(m[1]));
      m = /^order:(\d{1,9})$/.exec(action);
      if (m) return await this.orderDetail(msg, Number(m[1]), money);
      if (/^(prod|qty|cat|order|paylink):/.test(action)) return this.sorry('That option is no longer valid.');
      return undefined;
    } catch (err) {
      if (err instanceof AppError) return this.sorry(err.message);
      throw err;
    }
  }

  menu(businessName: string): BotReply {
    return {
      text: `👋 Welcome to ${businessName}! Tap a button to shop. (You can also type "help" for text commands.)`,
      buttons: [{ id: 'catalog', title: '🛍 Browse' }, { id: 'cart', title: '🛒 My cart' }, { id: 'orders', title: '📦 My orders' }],
    };
  }

  private async orderable(): Promise<Product[]> {
    return (await this.products.list({ activeOnly: true, limit: 1000 })).filter((p) => p.totalQuantity > 0);
  }

  private async catalog(): Promise<BotReply> {
    const products = await this.orderable();
    if (!products.length) return { text: 'Our shelves are being restocked — please check back soon!' };
    const counts = new Map<string, number>();
    for (const p of products) if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
    const cats = (await this.categories.list()).filter((c) => counts.has(c.id));
    if (cats.length <= 1) {
      const s = await this.settings.get();
      return this.category(cats[0]?.id ?? 'all', 0, (c) => formatMoney(c, s.currency));
    }
    const rows: ReplyListRow[] = cats.slice(0, 9).map((c) => ({ id: `cat:${c.id}:0`, title: c.name, description: plural(counts.get(c.id)!, 'product') }));
    rows.push({ id: 'cat:all:0', title: 'All products', description: plural(products.length, 'product') });
    return { text: 'What are you looking for?', list: { button: 'Categories', sections: [{ title: 'Categories', rows }] } };
  }

  private async category(categoryId: string, offset: number, money: (c: number) => string): Promise<BotReply> {
    if (categoryId !== 'all' && !(await this.categories.get(categoryId))) return this.sorry('That category no longer exists.');
    const all = (await this.orderable()).filter((p) => categoryId === 'all' || p.categoryId === categoryId);
    const page = all.slice(offset, offset + PAGE);
    if (!page.length) return { text: 'Nothing available here right now.', buttons: [{ id: 'catalog', title: '🛍 Browse' }] };
    const rows: ReplyListRow[] = page.map((p) => ({ id: `prod:${p.id}`, title: p.name, description: `${money(p.priceCents)} · ${p.totalQuantity} left` }));
    const rest = all.length - offset - PAGE;
    if (rest > 0) rows.push({ id: `cat:${categoryId}:${offset + PAGE}`, title: 'More…', description: `Show ${rest} more` });
    const name = categoryId === 'all' ? 'All products' : (await this.categories.get(categoryId))!.name;
    return { text: `${name} — pick a product:`, list: { button: 'Products', sections: [{ title: name, rows }] } };
  }

  private async product(productId: string, money: (c: number) => string): Promise<BotReply> {
    const p = await this.products.get(productId);
    if (!p) return this.sorry('That product no longer exists.');
    if (!p.isActive || p.totalQuantity <= 0) return this.sorry(`${p.name} is not available right now.`);
    const attrs = Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`).join(' · ');
    const text = [
      `*${p.name}*`,
      `${money(p.priceCents)} per ${p.unit} · ${p.totalQuantity} in stock`,
      p.description, attrs,
      'How many would you like?',
    ].filter(Boolean).join('\n');
    const rows = QTY_CHOICES.filter((n) => n <= p.totalQuantity).map((n) => ({ id: `qty:${p.id}:${n}`, title: String(n), description: money(n * p.priceCents) }));
    return { text, list: { button: 'Choose quantity', sections: [{ title: 'Quantity', rows }] } };
  }

  private async addToCart(msg: InboundMessage, productId: string, quantity: number, money: (c: number) => string): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const p = await this.products.get(productId);
    if (!p) return this.sorry('That product no longer exists.');
    const { added, capped } = await this.carts.add(customer.id, productId, quantity);
    const cart = await this.carts.get(customer.id);
    const items = cart.lines.reduce((n, l) => n + l.quantity, 0);
    const lines = [
      added > 0 ? `✅ Added ${added} × ${p.name} to your cart.` : `Your cart already has all available ${p.name}.`,
      capped ? `(We have only ${p.totalQuantity} available.)` : '',
      `🛒 Cart: ${plural(items, 'item')} · ${money(cart.totalCents)}`,
    ].filter(Boolean);
    return {
      text: lines.join('\n'),
      buttons: [{ id: 'checkout', title: '🧾 Checkout' }, { id: 'catalog', title: '🛍 Keep shopping' }, { id: 'cart:clear', title: '🗑 Clear cart' }],
    };
  }

  private async cartOf(msg: InboundMessage) {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    return { customer, cart: await this.carts.get(customer.id) };
  }

  private cartLines(cart: Awaited<ReturnType<ChatCartsRepo['get']>>, money: (c: number) => string): string {
    return [
      ...cart.lines.map((l) => `${l.quantity} × ${l.name} — ${money(l.quantity * l.unitPriceCents)}`),
      `*Total: ${money(cart.totalCents)}*`,
    ].join('\n');
  }

  private emptyCart(adjusted: boolean): BotReply {
    const note = adjusted ? 'Some items changed since you added them (no longer available). ' : '';
    return { text: `${note}Your cart is empty.`, buttons: [{ id: 'catalog', title: '🛍 Browse' }, { id: 'menu', title: '🏠 Menu' }] };
  }

  private async showCart(msg: InboundMessage, money: (c: number) => string): Promise<BotReply> {
    const { cart } = await this.cartOf(msg);
    if (!cart.lines.length) return this.emptyCart(cart.adjusted);
    const note = cart.adjusted ? '⚠️ Some items changed since you added them (stock or availability).\n' : '';
    return {
      text: `${note}🛒 *Your cart*\n${this.cartLines(cart, money)}`,
      buttons: [{ id: 'checkout', title: '🧾 Checkout' }, { id: 'catalog', title: '🛍 Keep shopping' }, { id: 'cart:clear', title: '🗑 Clear cart' }],
    };
  }

  private async clearCart(msg: InboundMessage): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    await this.carts.clear(customer.id);
    return { text: '🗑 Cart cleared.', buttons: [{ id: 'catalog', title: '🛍 Browse' }] };
  }

  private async checkout(msg: InboundMessage, money: (c: number) => string): Promise<BotReply> {
    const { cart } = await this.cartOf(msg);
    if (!cart.lines.length) return this.emptyCart(cart.adjusted);
    const { online, cod } = await this.payments.available();
    if (!online && !cod) return this.sorry('ordering is paused right now. Please try again later.');
    const note = cart.adjusted ? '⚠️ Some items changed since you added them — please check:\n' : '';
    const buttons = [
      ...(online ? [{ id: 'pay:online', title: '💳 Pay online' }] : []),
      ...(cod ? [{ id: 'pay:cod', title: '💵 Cash on delivery' }] : []),
      { id: 'cart', title: '✏️ Edit cart' },
    ];
    return { text: `${note}🧾 *Checkout*\n${this.cartLines(cart, money)}\n\nHow would you like to pay?`, buttons };
  }

  private async placeOrder(msg: InboundMessage, method: PaymentMethod, money: (c: number) => string): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const { online, cod } = await this.payments.available();
    if (method === 'ONLINE' && !online) return this.sorry('online payment is not available right now. You can choose Cash on delivery at checkout.');
    if (method === 'COD' && !cod) return this.sorry('cash on delivery is not available. Please pay online at checkout.');
    // Take the cart atomically: duplicate/concurrent taps find it empty instead of creating a second order (T46).
    const cart = await this.carts.take(customer.id);
    if (!cart.lines.length) return this.emptyCart(cart.adjusted);
    const items = cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity }));
    let order: Order;
    try {
      order = await this.orders.create({ customerId: customer.id, channel: msg.channel, paymentMethod: method, items });
    } catch (err) {
      await this.carts.restore(customer.id, items);
      throw err;
    }
    if (method === 'ONLINE') return this.payments.onlineCheckout(order, msg);
    return {
      text: `✅ Order #${order.number} placed — Cash on delivery.\nTotal: ${money(order.totalCents)}\nWe'll confirm shortly.`,
      buttons: [{ id: 'orders', title: '📦 My orders' }, { id: 'catalog', title: '🛍 Keep shopping' }],
    };
  }

  private static readonly STATUS: Record<Order['status'], string> = { PENDING: 'Pending', CONFIRMED: 'Confirmed', FULFILLED: 'Fulfilled', CANCELLED: 'Cancelled' };
  private static readonly METHOD: Record<PaymentMethod, string> = { COD: 'Cash on delivery', ONLINE: 'Online' };
  private static readonly PAYMENT: Record<Order['paymentStatus'], string> = { UNPAID: 'unpaid', PAID: 'paid ✅', REFUND_DUE: 'refund due', REFUNDED: 'refunded' };

  private async myOrders(msg: InboundMessage, money: (c: number) => string): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const orders = await this.orders.list({ customerId: customer.id, limit: 5 });
    if (!orders.length) return { text: 'You have no orders yet.', buttons: [{ id: 'catalog', title: '🛍 Browse' }] };
    const rows = orders.map((o) => {
      const items = o.items.reduce((n, i) => n + i.quantity, 0);
      return {
        id: `order:${o.number}`,
        title: `#${o.number} · ${ChatFlow.STATUS[o.status]}`,
        description: `${money(o.totalCents)} · ${plural(items, 'item')} · ${ChatFlow.METHOD[o.paymentMethod]}`,
      };
    });
    return { text: '📦 Your recent orders:', list: { button: 'My orders', sections: [{ title: 'Recent orders', rows }] } };
  }

  private async orderDetail(msg: InboundMessage, number: number, money: (c: number) => string): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const order = await this.orders.getByNumber(number);
    // Same answer for "missing" and "not yours": never reveal other customers' orders.
    if (!order || order.customerId !== customer.id) return this.sorry("we couldn't find that order.");
    const text = [
      `*Order #${order.number}*`,
      `Status: ${ChatFlow.STATUS[order.status]}`,
      `Payment: ${ChatFlow.METHOD[order.paymentMethod]} · ${ChatFlow.PAYMENT[order.paymentStatus]}`,
      ...order.items.map((i) => `${i.quantity} × ${i.name}`),
      `Total: ${money(order.totalCents)}`,
    ].join('\n');
    return { text, buttons: [{ id: 'orders', title: '📦 My orders' }, { id: 'catalog', title: '🛍 Browse' }] };
  }

  /** paylink:<n> — (re)send the pay link for my own unpaid online order. */
  private async payLink(msg: InboundMessage, number: number): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const order = await this.orders.getByNumber(number);
    if (!order || order.customerId !== customer.id) return this.sorry("we couldn't find that order.");
    const back = [{ id: 'orders', title: '📦 My orders' }, { id: 'catalog', title: '🛍 Browse' }];
    if (order.status === 'CANCELLED') return { text: `Order #${order.number} was cancelled, so there is nothing to pay.`, buttons: back };
    if (order.paymentStatus === 'PAID') return { text: `✅ Order #${order.number} is already paid. Thank you!`, buttons: back };
    if (order.paymentStatus === 'REFUND_DUE') return { text: `We received a payment for order #${order.number} and a refund is being arranged.`, buttons: back };
    if (order.paymentStatus === 'REFUNDED') return { text: `Your payment for order #${order.number} has been refunded.`, buttons: back };
    if (order.paymentMethod === 'COD') return { text: `Order #${order.number} is cash on delivery — nothing to pay online.`, buttons: back };
    return this.payments.resendLink(order, msg);
  }

  private sorry(message: string): BotReply {
    return { text: `Sorry — ${message}`, buttons: [{ id: 'catalog', title: '🛍 Browse' }, { id: 'menu', title: '🏠 Menu' }] };
  }
}
