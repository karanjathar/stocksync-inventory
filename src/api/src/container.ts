import type pg from 'pg';
import pino, { type Logger } from 'pino';
import type { Env } from './config/env.js';
import { UsersRepo } from './repositories/users.js';
import { SimpleRepo } from './repositories/simple.js';
import { ProductsRepo } from './repositories/products.js';
import { CustomersRepo } from './repositories/customers.js';
import type { Category, Supplier, Warehouse } from './domain/types.js';
import { AuthService } from './services/auth.js';
import { StockService } from './services/stock.js';
import { SettingsService } from './services/settings.js';
import { EventBus } from './realtime/bus.js';
import { OrdersService } from './services/orders.js';
import { AlertService } from './services/alerts.js';
import type { Messenger } from './services/messenger.js';
import { BotService } from './services/bot.js';
import { ChatFlow } from './services/chatFlow.js';
import { ChatCartsRepo } from './repositories/chatCarts.js';
import { InboxService } from './services/inbox.js';
import { OrderNotifier } from './services/orderNotifier.js';
import { MessagesRepo } from './repositories/messages.js';
import { ChannelHub } from './channels/hub.js';
import { WhatsAppAdapter } from './channels/whatsapp.js';
import { MetaPageAdapter } from './channels/metaPage.js';
import { TelegramAdapter } from './channels/telegram.js';
import { ImageStorage } from './storage/blob.js';
import { RazorpayClient } from './payments/razorpay.js';
import { PaymentService } from './services/payments.js';
import { PurchasesService } from './services/purchases.js';
import { BillsService } from './services/bills.js';
import { ReorderService } from './services/reorder.js';
import { TaxRatesService } from './services/taxRates.js';
import { InvoicesService } from './services/invoices.js';
import { DocumentsService } from './services/documents.js';

export interface ContainerOverrides {
  logger?: Logger;
  fetch?: typeof fetch;
  /** Replaces the channel hub for outbound messages (tests). */
  messenger?: Messenger;
}

export function createContainer(opts: { env: Env; pool: pg.Pool } & ContainerOverrides) {
  const { env, pool } = opts;
  const logger = opts.logger ?? pino({ level: env.NODE_ENV === 'test' ? 'silent' : 'info' });
  const repos = {
    users: new UsersRepo(pool),
    categories: new SimpleRepo<Category>(pool, 'categories', { name: 'name' }, 'name', ['name']),
    products: new ProductsRepo(pool),
    suppliers: new SimpleRepo<Supplier>(pool, 'suppliers', { name: 'name', email: 'email', phone: 'phone', notes: 'notes' }, 'name', ['name', 'email', 'phone']),
    warehouses: new SimpleRepo<Warehouse>(pool, 'warehouses', { code: 'code', name: 'name', address: 'address' }, 'code', ['code', 'name']),
  };
  const auth = new AuthService(repos.users, env.JWT_SECRET, env.JWT_EXPIRES_IN, env.NODE_ENV === 'test' ? 4 : 12);
  const stock = new StockService(pool, (err) => logger.error({ err }, 'stock observer failed'));
  const events = new EventBus();
  stock.onChanged(async (changes) => {
    for (const ch of changes) {
      const p = await repos.products.get(ch.productId);
      if (!p) continue;
      events.publish({ type: 'stock.changed', productId: p.id, sku: p.sku, warehouseId: ch.warehouseId, quantity: ch.quantity, totalQuantity: p.totalQuantity });
    }
  });
  const customers = new CustomersRepo(pool);
  const settings = new SettingsService(pool);
  const orders = new OrdersService(pool, stock, settings, events, (err) => logger.error({ err }, 'order observer failed'));
  const messages = new MessagesRepo(pool);
  const fetchFn = opts.fetch ?? fetch;
  const hub = new ChannelHub([
    new WhatsAppAdapter({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, graphVersion: env.META_GRAPH_VERSION, graphBase: env.META_GRAPH_BASE }, fetchFn),
    new MetaPageAdapter('messenger', { token: env.MESSENGER_PAGE_TOKEN, graphVersion: env.META_GRAPH_VERSION, graphBase: env.META_GRAPH_BASE }, fetchFn),
    new MetaPageAdapter('instagram', { token: env.INSTAGRAM_PAGE_TOKEN, graphVersion: env.META_GRAPH_VERSION, graphBase: env.META_GRAPH_BASE }, fetchFn),
    new TelegramAdapter({ token: env.TELEGRAM_BOT_TOKEN }, fetchFn),
  ], messages);
  const messenger: Messenger = opts.messenger ?? hub;
  const alerts = new AlertService(repos.products, settings, events, messenger, logger);
  stock.onChanged((changes) => alerts.onStockChanged(changes));
  const notifier = new OrderNotifier(customers, settings, messenger);
  orders.onStatusChange((order, previous) => notifier.onStatusChange(order, previous));
  const carts = new ChatCartsRepo(pool);
  const chatFlow = new ChatFlow(repos.products, repos.categories, customers, carts, settings, orders);
  const bot = new BotService(repos.products, orders, customers, settings, chatFlow);
  const inbox = new InboxService(messages, events, bot, messenger, logger);
  const razorpay = new RazorpayClient({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, apiBase: env.RAZORPAY_API_BASE }, fetchFn);
  const payments = new PaymentService(pool, razorpay, settings, orders, customers, env.PUBLIC_BASE_URL, logger, events, messenger);
  const images = new ImageStorage(env.AZURE_STORAGE_CONNECTION_STRING, env.AZURE_STORAGE_CONTAINER);
  chatFlow.setPaymentOptions(payments.chatOptions());
  orders.onStatusChange((order, previous) => payments.onOrderStatusChange(order, previous));
  const purchases = new PurchasesService(pool, stock);
  const bills = new BillsService(pool);
  const reorder = new ReorderService(pool, purchases, settings);
  const taxRates = new TaxRatesService(pool);
  const invoices = new InvoicesService(pool);
  orders.setInvoices(invoices);
  const documents = new DocumentsService(pool, orders, settings);
  return { env, pool, logger, repos, purchases, bills, reorder, taxRates, invoices, documents, auth, stock, customers, settings, events, orders, alerts, messages, hub, messenger, bot, inbox, images, carts, chatFlow, razorpay, payments };
}

export type Container = ReturnType<typeof createContainer>;
