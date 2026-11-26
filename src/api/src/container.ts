import type pg from 'pg';
import { type Logger } from 'pino';
import type { Env } from './config/env.js';
import { UsersRepo } from './repositories/users.js';
import { SimpleRepo } from './repositories/simple.js';
import { ProductsRepo } from './repositories/products.js';
import { CustomersRepo } from './repositories/customers.js';
import type { Category, Supplier, Warehouse } from './domain/types.js';
import { AuthService } from './services/auth.js';
import { PlatformService } from './services/platform.js';
import { currentTenantId, DEFAULT_TENANT_ID, runWithTenant } from './db/tenant.js';
import { TenantDirectory, TenantsRepo } from './repositories/tenants.js';
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
import { JobQueue } from './jobs/queue.js';
import { Maintenance } from './jobs/maintenance.js';
import { PurchaseOrdersService } from './services/purchaseOrders.js';
import { ReorderService } from './services/reorder.js';
import { StockCountsService } from './services/stockCounts.js';
import { InvoiceService } from './services/invoices.js';
import { InvoiceNotifier } from './services/invoiceNotifier.js';
import { registerMessageSend } from './jobs/messageSend.js';
import { randomUUID } from 'node:crypto';
import { WhatsAppAdapter } from './channels/whatsapp.js';
import { MetaPageAdapter } from './channels/metaPage.js';
import { TelegramAdapter } from './channels/telegram.js';
import { ImageStorage } from './storage/blob.js';
import { RazorpayClient, type RazorpayProvider } from './payments/razorpay.js';
import { ChannelCredentials } from './services/channelCredentials.js';
import { SecretBox } from './services/secrets.js';
import type { ChannelAdapter } from './channels/types.js';
import { PaymentService } from './services/payments.js';
import { AcsEmailSender, LogEmailSender, type EmailSender } from './services/email.js';
import { SignupService } from './services/signup.js';
import { OnboardingService } from './services/demoData.js';
import { PlanAdmin, PlansService } from './services/plans.js';
import { BillingService, BillingWebhooks } from './services/billing.js';
import { AuditService } from './services/audit.js';
import { createLogger } from './logger.js';
import { AnthropicClient } from './ai/client.js';
import { AiBudget } from './ai/budget.js';
import { AiGateway } from './ai/gateway.js';
import { OrderingAgent } from './ai/orderingAgent.js';
import { InventoryAssistant } from './ai/inventoryAssistant.js';
import { LoginGuard } from './services/loginGuard.js';
import { PlanRateLimits } from './http/middleware/rateLimit.js';
import { SessionService } from './services/sessions.js';
import { DataRights, TenantEraser } from './services/tenantDeletion.js';
import { RazorpaySubscriptions } from './payments/razorpaySubscriptions.js';

export interface ContainerOverrides {
  /** Connection for the platform console (role with no access to business data). */
  platformPool?: pg.Pool;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Replaces the channel hub for outbound messages (tests). */
  messenger?: Messenger;
  /** Replaces the pause between AI retries (tests). */
  aiWait?: (ms: number) => Promise<void>;
  /** How long a business's plan rate limit is cached (tests set 0). */
  rateLimitCacheMs?: number;
  /** Replaces the email service (tests). */
  emailSender?: EmailSender;
}

export function createContainer(opts: { env: Env; pool: pg.Pool } & ContainerOverrides) {
  const { env, pool } = opts;
  const logger = opts.logger ?? createLogger(env.NODE_ENV === 'test' ? 'silent' : 'info');
  const repos = {
    users: new UsersRepo(pool),
    categories: new SimpleRepo<Category>(pool, 'categories', { name: 'name' }, 'name', ['name']),
    products: new ProductsRepo(pool),
    suppliers: new SimpleRepo<Supplier>(pool, 'suppliers', { name: 'name', email: 'email', phone: 'phone', notes: 'notes', leadTimeDays: 'lead_time_days' }, 'name', ['name', 'email', 'phone']),
    warehouses: new SimpleRepo<Warehouse>(pool, 'warehouses', { code: 'code', name: 'name', address: 'address' }, 'code', ['code', 'name']),
  };
  const rounds = env.NODE_ENV === 'test' ? 4 : 12;
  const tenants = new TenantsRepo(pool);
  const tenantDirectory = new TenantDirectory(pool);
  const auth = new AuthService(repos.users, env.JWT_SECRET, env.JWT_EXPIRES_IN, rounds, tenants);
  // The platform console uses its own restricted database role; without that pool its routes answer 501.
  const platform = opts.platformPool ? new PlatformService(opts.platformPool, env.JWT_SECRET, env.JWT_EXPIRES_IN, rounds) : undefined;
  const emailSender = opts.emailSender ?? (env.EMAIL_CONNECTION_STRING ? new AcsEmailSender(env.EMAIL_CONNECTION_STRING, env.EMAIL_FROM, opts.fetch) : new LogEmailSender(logger, env.NODE_ENV !== 'production'));
  const signup = env.SIGNUP_ENABLED ? new SignupService(pool, emailSender, env.PUBLIC_BASE_URL, logger, rounds) : undefined;
  const stock = new StockService(pool, (err) => logger.error({ err }, 'stock observer failed'));
  const events = new EventBus(env.TENANT_FALLBACK === 'default' ? DEFAULT_TENANT_ID : undefined);
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
  const purchaseOrders = new PurchaseOrdersService(pool, stock);
  const reorder = new ReorderService(pool, purchaseOrders, settings);
  const stockCounts = new StockCountsService(pool, stock);
  const audit = new AuditService(pool);
  const aiClient = new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, apiBase: env.AI_API_BASE, model: env.AI_MODEL, timeoutMs: env.AI_TIMEOUT_MS, maxAttempts: 3 }, opts.fetch ?? fetch, opts.aiWait);
  const ai = new AiGateway(pool, aiClient, new AiBudget(pool), env.AI_DISABLED, logger);
  const loginGuard = new LoginGuard(pool);
  const rateLimits = new PlanRateLimits(async () => (await pool.query<{ n: number }>('SELECT p.requests_per_minute AS n FROM plans p JOIN tenants t ON t.plan = p.code WHERE t.id = current_tenant()')).rows[0]?.n ?? 120, opts.rateLimitCacheMs ?? 30_000);
  const sessions = new SessionService(pool, env.JWT_SECRET, runWithTenant);
  const dataRights = new DataRights(pool);
  const plans = new PlansService(pool);
  const subscriptions = new RazorpaySubscriptions({ keyId: env.RAZORPAY_PLATFORM_KEY_ID, keySecret: env.RAZORPAY_PLATFORM_KEY_SECRET, webhookSecret: env.RAZORPAY_PLATFORM_WEBHOOK_SECRET, apiBase: env.RAZORPAY_API_BASE }, opts.fetch ?? fetch);
  const billing = new BillingService(pool, plans, subscriptions, env.BILLING_TRIAL_DAYS);
  const billingWebhooks = opts.platformPool ? new BillingWebhooks(opts.platformPool, env.BILLING_GRACE_DAYS, logger) : undefined;
  const planAdmin = opts.platformPool ? new PlanAdmin(opts.platformPool) : undefined;
  const invoices = new InvoiceService(pool, settings, undefined, logger, (db) => plans.consumeOrThrow('invoices', db));
  orders.onStatusChange((order, previous) => invoices.onOrderStatusChange(order, previous));
  const messages = new MessagesRepo(pool);
  const fetchFn = opts.fetch ?? fetch;
  // Per-business credentials. The server's own environment keys apply only to the original default business (single-business installs).
  const defined = (o: Record<string, string | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const fallbackIsDefault = env.TENANT_FALLBACK === 'default';
  const channelCredentials = new ChannelCredentials(pool, SecretBox.fromEnv(env), {
    meta: defined({ appSecret: env.META_APP_SECRET, verifyToken: env.META_VERIFY_TOKEN }),
    whatsapp: defined({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }),
    messenger: defined({ pageToken: env.MESSENGER_PAGE_TOKEN }), instagram: defined({ pageToken: env.INSTAGRAM_PAGE_TOKEN }),
    telegram: defined({ botToken: env.TELEGRAM_BOT_TOKEN, webhookSecret: env.TELEGRAM_WEBHOOK_SECRET }),
    razorpay: defined({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET }),
  }, fallbackIsDefault, logger);
  const tenantKey = () => currentTenantId() ?? (fallbackIsDefault ? DEFAULT_TENANT_ID : 'none');
  const adapterCache = new Map<string, { sig: string; adapter: ChannelAdapter }>();
  const hub = new ChannelHub([], messages, () => settings.get(), async (channel) => {
    const cfg = await channelCredentials.get(channel === 'telegram' ? 'telegram' : channel) as Record<string, string> | undefined;
    const sig = JSON.stringify(cfg ?? null);
    const key = `${tenantKey()}:${channel}`;
    const hit = adapterCache.get(key);
    if (hit?.sig === sig) return hit.adapter;
    const graph = { graphVersion: env.META_GRAPH_VERSION, ...(env.META_GRAPH_BASE ? { graphBase: env.META_GRAPH_BASE } : {}) };
    const adapter: ChannelAdapter = channel === 'whatsapp' ? new WhatsAppAdapter({ ...(cfg ? { token: cfg.token, phoneNumberId: cfg.phoneNumberId } : {}), ...graph }, fetchFn)
      : channel === 'telegram' ? new TelegramAdapter({ ...(cfg ? { token: cfg.botToken } : {}) }, fetchFn)
      : new MetaPageAdapter(channel, { ...(cfg ? { token: cfg.pageToken } : {}), ...graph }, fetchFn);
    adapterCache.set(key, { sig, adapter });
    return adapter;
  }, () => plans.consume('chat_messages'));
  const jobs = new JobQueue(pool, { workerId: `api-${process.pid}-${randomUUID().slice(0, 8)}`, onError: (err, job) => logger.warn({ err: String(err), job: job?.kind, jobId: job?.id }, 'job failed') });
  registerMessageSend(jobs, hub);
  const maintenance = new Maintenance(pool, orders, settings, logger);
  maintenance.register(jobs);
  const messenger: Messenger = opts.messenger ?? hub;
  const alerts = new AlertService(repos.products, settings, events, messenger, logger);
  stock.onChanged((changes) => alerts.onStockChanged(changes));
  const notifier = new OrderNotifier(customers, settings, messenger);
  orders.onStatusChange((order, previous) => notifier.onStatusChange(order, previous));
  const invoiceNotifier = new InvoiceNotifier(invoices, customers, settings, messenger, env.JWT_SECRET, env.PUBLIC_BASE_URL, logger);
  orders.onStatusChange((order, previous) => invoiceNotifier.onStatusChange(order, previous));
  const carts = new ChatCartsRepo(pool);
  const chatFlow = new ChatFlow(repos.products, repos.categories, customers, carts, settings, orders);
  const bot = new BotService(repos.products, orders, customers, settings, chatFlow);
  bot.setAgent(new OrderingAgent(ai, repos.products, carts, customers, chatFlow, settings, pool, logger)); // answers only when AI is configured, on and within budget
  const assistant = new InventoryAssistant(ai, pool, repos.products, reorder, orders, settings);
  const inbox = new InboxService(messages, events, bot, messenger, logger);
  const razorpayCache = new Map<string, { sig: string; client: RazorpayClient }>();
  const razorpayProvider: RazorpayProvider = {
    async client() {
      const cfg = await channelCredentials.get('razorpay');
      const sig = JSON.stringify(cfg ?? null);
      const key = tenantKey();
      const hit = razorpayCache.get(key);
      if (hit?.sig === sig) return hit.client;
      const client = new RazorpayClient({ ...(cfg ?? {}), apiBase: env.RAZORPAY_API_BASE }, fetchFn);
      razorpayCache.set(key, { sig, client });
      return client;
    },
  };
  const onboarding = new OnboardingService(pool, repos.products, stock, async () => (await channelCredentials.summary()).some((k) => k.kind === 'whatsapp' && k.configured));
  const payments = new PaymentService(pool, razorpayProvider, settings, orders, customers, env.PUBLIC_BASE_URL, logger, events, messenger);
  const images = new ImageStorage(env.AZURE_STORAGE_CONNECTION_STRING, env.AZURE_STORAGE_CONTAINER);
  const tenantEraser = opts.platformPool ? new TenantEraser(opts.platformPool, logger, async (tenantId) => { await images.deleteTenantImages(tenantId); }) : undefined;
  chatFlow.setPaymentOptions(payments.chatOptions());
  orders.onStatusChange((order, previous) => payments.onOrderStatusChange(order, previous));
  return { env, pool, logger, repos, auth, platform, signup, onboarding, plans, planAdmin, audit, sessions, ai, aiClient, assistant, loginGuard, rateLimits, dataRights, tenantEraser, billing, billingWebhooks, subscriptions, emailSender, tenants, tenantDirectory, stock, customers, settings, events, orders, alerts, messages, hub, jobs, maintenance, purchaseOrders, reorder, stockCounts, invoices, messenger, bot, inbox, images, carts, chatFlow, razorpayProvider, channelCredentials, payments };
}

export type Container = ReturnType<typeof createContainer>;
