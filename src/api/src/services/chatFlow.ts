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
import { count, currentLang, t, type MessageKey } from '../i18n/messages.js';
import type { SettingsService } from './settings.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGE = 9;
const QTY_CHOICES = [1, 2, 3, 4, 5, 10];

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
  onlineCheckout: async (order) => ({ text: `Order #${order.number} created. We'll send your payment link shortly.` }), // replaced by the payments service whenever online payment is configured
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
      if (action === 'lang:en' || action === 'lang:hi') return { ...this.menu(s.businessName), text: `${t('lang.set')}\n\n${this.menu(s.businessName).text}` }; // the language itself is stored by BotService before this runs
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
      if (/^(prod|qty|cat|order|paylink):/.test(action)) return this.sorry(t('sorry.invalidOption'));
      return undefined;
    } catch (err) {
      if (err instanceof AppError) return this.sorry(err.message);
      throw err;
    }
  }

  menu(businessName: string): BotReply {
    return {
      text: t('menu.welcome', { name: businessName }),
      buttons: [{ id: 'catalog', title: t('btn.browse') }, { id: 'cart', title: t('btn.cart') }, { id: 'orders', title: t('btn.orders') }],
    };
  }

  private async orderable(): Promise<Product[]> {
    return (await this.products.list({ activeOnly: true, limit: 1000 })).filter((p) => p.totalQuantity > 0);
  }

  private async catalog(): Promise<BotReply> {
    const products = await this.orderable();
    if (!products.length) return { text: t('catalog.restocking') };
    const counts = new Map<string, number>();
    for (const p of products) if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
    const cats = (await this.categories.list()).filter((c) => counts.has(c.id));
    if (cats.length <= 1) {
      const s = await this.settings.get();
      return this.category(cats[0]?.id ?? 'all', 0, (c) => formatMoney(c, s.currency));
    }
    const rows: ReplyListRow[] = cats.slice(0, 9).map((c) => ({ id: `cat:${c.id}:0`, title: c.name, description: count('product', counts.get(c.id)!) }));
    rows.push({ id: 'cat:all:0', title: t('catalog.all'), description: count('product', products.length) });
    rows.push({ id: currentLang() === 'hi' ? 'lang:en' : 'lang:hi', title: t('row.switchLang') });
    return { text: t('catalog.ask'), list: { button: t('catalog.categories'), sections: [{ title: t('catalog.categories'), rows }] } };
  }

  private async category(categoryId: string, offset: number, money: (c: number) => string): Promise<BotReply> {
    if (categoryId !== 'all' && !(await this.categories.get(categoryId))) return this.sorry(t('category.gone'));
    const all = (await this.orderable()).filter((p) => categoryId === 'all' || p.categoryId === categoryId);
    const page = all.slice(offset, offset + PAGE);
    if (!page.length) return { text: t('category.empty'), buttons: [{ id: 'catalog', title: t('btn.browse') }] };
    const rows: ReplyListRow[] = page.map((p) => ({ id: `prod:${p.id}`, title: p.name, description: t('row.left', { price: money(p.priceCents), n: p.totalQuantity }) }));
    const rest = all.length - offset - PAGE;
    if (rest > 0) rows.push({ id: `cat:${categoryId}:${offset + PAGE}`, title: t('more.title'), description: t('more.desc', { n: rest }) });
    const name = categoryId === 'all' ? t('catalog.all') : (await this.categories.get(categoryId))!.name;
    return { text: t('category.pick', { name }), list: { button: t('category.products'), sections: [{ title: name, rows }] } };
  }

  private async product(productId: string, money: (c: number) => string): Promise<BotReply> {
    const p = await this.products.get(productId);
    if (!p) return this.sorry(t('product.gone'));
    if (!p.isActive || p.totalQuantity <= 0) return this.sorry(t('product.unavailable', { name: p.name }));
    const attrs = Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`).join(' · ');
    const text = [
      `*${p.name}*`,
      t('product.line', { price: money(p.priceCents), unit: p.unit, n: p.totalQuantity }),
      p.description, attrs,
      t('product.howMany'),
    ].filter(Boolean).join('\n');
    const rows = QTY_CHOICES.filter((n) => n <= p.totalQuantity).map((n) => ({ id: `qty:${p.id}:${n}`, title: String(n), description: money(n * p.priceCents) }));
    return { text, list: { button: t('product.chooseQty'), sections: [{ title: t('product.quantity'), rows }] } };
  }

  private async addToCart(msg: InboundMessage, productId: string, quantity: number, money: (c: number) => string): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const p = await this.products.get(productId);
    if (!p) return this.sorry(t('product.gone'));
    const { added, capped } = await this.carts.add(customer.id, productId, quantity);
    const cart = await this.carts.get(customer.id);
    const items = cart.lines.reduce((n, l) => n + l.quantity, 0);
    const lines = [
      added > 0 ? t('cart.added', { n: added, name: p.name }) : t('cart.already', { name: p.name }),
      capped ? t('cart.capped', { n: p.totalQuantity }) : '',
      t('cart.summary', { items: count('item', items), total: money(cart.totalCents) }),
    ].filter(Boolean);
    return {
      text: lines.join('\n'),
      buttons: [{ id: 'checkout', title: t('btn.checkout') }, { id: 'catalog', title: t('btn.keep') }, { id: 'cart:clear', title: t('btn.clear') }],
    };
  }

  private async cartOf(msg: InboundMessage) {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    return { customer, cart: await this.carts.get(customer.id) };
  }

  private cartLines(cart: Awaited<ReturnType<ChatCartsRepo['get']>>, money: (c: number) => string): string {
    return [
      ...cart.lines.map((l) => `${l.quantity} × ${l.name} — ${money(l.quantity * l.unitPriceCents)}`),
      t('cart.total', { total: money(cart.totalCents) }),
    ].join('\n');
  }

  private emptyCart(adjusted: boolean): BotReply {
    const note = adjusted ? t('cart.changedEmpty') : '';
    return { text: `${note}${t('cart.empty')}`, buttons: [{ id: 'catalog', title: t('btn.browse') }, { id: 'menu', title: t('btn.menu') }, { id: currentLang() === 'hi' ? 'lang:en' : 'lang:hi', title: t('btn.switchLang') }] };
  }

  private async showCart(msg: InboundMessage, money: (c: number) => string): Promise<BotReply> {
    const { cart } = await this.cartOf(msg);
    if (!cart.lines.length) return this.emptyCart(cart.adjusted);
    const note = cart.adjusted ? `${t('cart.changed')}\n` : '';
    return {
      text: `${note}${t('cart.title')}\n${this.cartLines(cart, money)}`,
      buttons: [{ id: 'checkout', title: t('btn.checkout') }, { id: 'catalog', title: t('btn.keep') }, { id: 'cart:clear', title: t('btn.clear') }],
    };
  }

  private async clearCart(msg: InboundMessage): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    await this.carts.clear(customer.id);
    return { text: t('cart.cleared'), buttons: [{ id: 'catalog', title: t('btn.browse') }] };
  }

  private async checkout(msg: InboundMessage, money: (c: number) => string): Promise<BotReply> {
    const { cart } = await this.cartOf(msg);
    if (!cart.lines.length) return this.emptyCart(cart.adjusted);
    const { online, cod } = await this.payments.available();
    if (!online && !cod) return this.sorry(t('checkout.paused'));
    const note = cart.adjusted ? `${t('checkout.changed')}\n` : '';
    const buttons = [
      ...(online ? [{ id: 'pay:online', title: t('btn.payOnline') }] : []),
      ...(cod ? [{ id: 'pay:cod', title: t('btn.cod') }] : []),
      { id: 'cart', title: t('btn.edit') },
    ];
    return { text: `${note}${t('checkout.title')}\n${this.cartLines(cart, money)}\n\n${t('checkout.how')}`, buttons };
  }

  private async placeOrder(msg: InboundMessage, method: PaymentMethod, money: (c: number) => string): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const { online, cod } = await this.payments.available();
    if (method === 'ONLINE' && !online) return this.sorry(t('pay.onlineUnavailable'));
    if (method === 'COD' && !cod) return this.sorry(t('pay.codUnavailable'));
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
      text: t('order.placedCod', { n: order.number, total: money(order.totalCents) }),
      buttons: [{ id: 'orders', title: t('btn.orders') }, { id: 'catalog', title: t('btn.keep') }],
    };
  }

  private async myOrders(msg: InboundMessage, money: (c: number) => string): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const orders = await this.orders.list({ customerId: customer.id, limit: 5 });
    if (!orders.length) return { text: t('orders.none'), buttons: [{ id: 'catalog', title: t('btn.browse') }] };
    const rows = orders.map((o) => {
      const items = o.items.reduce((n, i) => n + i.quantity, 0);
      return {
        id: `order:${o.number}`,
        title: `#${o.number} · ${t(`status.${o.status}` as MessageKey)}`,
        description: `${money(o.totalCents)} · ${count('item', items)} · ${t(`method.${o.paymentMethod}` as MessageKey)}`,
      };
    });
    return { text: t('orders.recent'), list: { button: t('orders.button'), sections: [{ title: t('orders.section'), rows }] } };
  }

  private async orderDetail(msg: InboundMessage, number: number, money: (c: number) => string): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const order = await this.orders.getByNumber(number);
    // Same answer for "missing" and "not yours": never reveal other customers' orders.
    if (!order || order.customerId !== customer.id) return this.sorry(t('order.notFound'));
    const text = [
      t('order.title', { n: order.number }),
      t('order.status', { s: t(`status.${order.status}` as MessageKey) }),
      t('order.payment', { method: t(`method.${order.paymentMethod}` as MessageKey), state: t(`paystate.${order.paymentStatus}` as MessageKey) }),
      ...order.items.map((i) => `${i.quantity} × ${i.name}`),
      t('order.total', { total: money(order.totalCents) }),
    ].join('\n');
    return { text, buttons: [{ id: 'orders', title: t('btn.orders') }, { id: 'catalog', title: t('btn.browse') }] };
  }

  /** paylink:<n> — (re)send the pay link for my own unpaid online order. */
  private async payLink(msg: InboundMessage, number: number): Promise<BotReply> {
    const customer = await this.customers.findOrCreateByChannel(msg.channel, msg.from, msg.senderName);
    const order = await this.orders.getByNumber(number);
    if (!order || order.customerId !== customer.id) return this.sorry(t('order.notFound'));
    const back = [{ id: 'orders', title: t('btn.orders') }, { id: 'catalog', title: t('btn.browse') }];
    if (order.status === 'CANCELLED') return { text: t('paylink.cancelled', { n: order.number }), buttons: back };
    if (order.paymentStatus === 'PAID') return { text: t('paylink.paid', { n: order.number }), buttons: back };
    if (order.paymentStatus === 'REFUND_DUE') return { text: t('paylink.refundDue', { n: order.number }), buttons: back };
    if (order.paymentStatus === 'REFUNDED') return { text: t('paylink.refunded', { n: order.number }), buttons: back };
    if (order.paymentMethod === 'COD') return { text: t('paylink.cod', { n: order.number }), buttons: back };
    return this.payments.resendLink(order, msg);
  }

  private sorry(message: string): BotReply {
    return { text: t('sorry.prefix', { message }), buttons: [{ id: 'catalog', title: t('btn.browse') }, { id: 'menu', title: t('btn.menu') }, { id: currentLang() === 'hi' ? 'lang:en' : 'lang:hi', title: t('btn.switchLang') }] };
  }
}
