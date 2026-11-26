import type { Logger } from 'pino';
import type { ChannelName, Order, OrderStatus } from '../domain/types.js';
import type { CustomersRepo } from '../repositories/customers.js';
import type { InvoiceService } from './invoices.js';
import { signInvoiceUrl } from './signedUrl.js';
import { formatMoney } from './money.js';
import type { Messenger } from './messenger.js';
import type { SettingsService } from './settings.js';

const CHAT_CHANNELS: readonly string[] = ['whatsapp', 'messenger', 'instagram', 'telegram'];
/** Long enough for WhatsApp's servers to fetch the file, including a few outbox retries; short enough to be useless later. */
export const INVOICE_LINK_TTL_MS = 2 * 60 * 60_000;

/** Order observer: after confirmation, sends the shopper their invoice on their own chat channel. */
export class InvoiceNotifier {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly customers: CustomersRepo,
    private readonly settings: SettingsService,
    private readonly messenger: Messenger,
    private readonly secret: string,
    private readonly baseUrl: string,
    private readonly logger?: Logger,
  ) {}

  async onStatusChange(order: Order, previous: OrderStatus | null): Promise<void> {
    if (order.status !== 'CONFIRMED' || previous !== 'PENDING' || !CHAT_CHANNELS.includes(order.channel)) return;
    try {
      const invoice = await this.invoices.getByOrder(order.id);
      if (!invoice || invoice.status !== 'ISSUED') return; // invoicing not set up, or nothing to send
      const customer = await this.customers.get(order.customerId);
      if (!customer?.channelUserId) return;
      const s = await this.settings.get();
      const channel = order.channel as ChannelName;
      const url = signInvoiceUrl(this.secret, this.baseUrl, invoice.id, INVOICE_LINK_TTL_MS);
      const total = formatMoney(invoice.totalCents, s.currency);
      const caption = `🧾 ${s.businessName}: tax invoice ${invoice.number} for order #${order.number} (${total}).`;
      const notify = { event: 'invoice_ready' as const, params: { orderNumber: String(order.number), total, businessName: s.businessName, customerName: customer.name, invoiceLink: url } };
      if (this.messenger.document && channel === 'whatsapp') {
        await this.messenger.document(channel, customer.channelUserId, { url, filename: `invoice-${invoice.number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`, caption }, notify);
      } else {
        await this.messenger.send(channel, customer.channelUserId, `${caption}\n${url}`, notify);
      }
    } catch (err) {
      this.logger?.warn({ err: String(err), orderId: order.id }, 'invoice delivery failed'); // never blocks the order
    }
  }
}
