import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Logger } from 'pino';
import { withTx } from '../db/tx.js';
import { AppError, ConflictError, NotConfiguredError, NotFoundError, ValidationError } from '../domain/errors.js';
import { z } from 'zod';
import type { Payment } from '../domain/types.js';
import type { EventBus } from '../realtime/bus.js';
import type { Messenger } from './messenger.js';
import { RazorpayError } from '../payments/razorpay.js';
import { renderPlain, type BotReply } from '../channels/reply.js';
import type { Order, OrderStatus } from '../domain/types.js';
import { formatMoney } from './money.js';
import type { PaymentOptions } from './chatFlow.js';
import type { RazorpayClient } from '../payments/razorpay.js';
import type { CustomersRepo } from '../repositories/customers.js';
import type { OrdersService } from './orders.js';
import type { SettingsService } from './settings.js';

export interface PaymentsConfig { razorpayConfigured: boolean; onlineAvailable: boolean; codEnabled: boolean; reason?: string }

const PAYMENT_COLS = `id, order_id AS "orderId", provider, provider_ref AS "providerRef", reference_id AS "referenceId", status,
  amount_cents AS "amountCents", currency, short_url AS "shortUrl", provider_payment_id AS "providerPaymentId",
  expires_at AS "expiresAt", created_at AS "createdAt"`;
/** Razorpay requires expire_by ≥ 15 minutes in the future; keep a safety margin. */
const MIN_EXPIRY_MINUTES = 16;

export class PaymentService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly razorpay: RazorpayClient,
    private readonly settings: SettingsService,
    private readonly orders: OrdersService,
    private readonly customers: CustomersRepo,
    private readonly publicBaseUrl: string,
    private readonly logger: Logger,
    private readonly events: EventBus,
    private readonly messenger: Messenger,
  ) {}

  async config(): Promise<PaymentsConfig> {
    const s = await this.settings.get();
    const razorpayConfigured = this.razorpay.isConfigured();
    const base = { razorpayConfigured, codEnabled: s.payments.codEnabled };
    if (!razorpayConfigured) return { ...base, onlineAvailable: false, reason: 'Razorpay keys are not configured on the server.' };
    if (!s.payments.onlineEnabled) return { ...base, onlineAvailable: false, reason: 'Online payments are disabled in Settings.' };
    if (s.currency !== 'INR') return { ...base, onlineAvailable: false, reason: `Razorpay Payment Links require the shop currency to be INR (currently ${s.currency}).` };
    return { ...base, onlineAvailable: true };
  }

  /**
   * Returns the order's open payment link, creating one if needed. Amount always comes from the order (server-side).
   * Serialised per order with an advisory lock, so concurrent callers never create two live links.
   */
  async linkForOrder(orderId: string): Promise<Payment> {
    const order = await this.orders.get(orderId);
    if (!order) throw new NotFoundError('Order');
    if (order.status === 'CANCELLED') throw new ConflictError('Order is cancelled');
    if (order.paymentStatus !== 'UNPAID') throw new ConflictError(`Order is already ${order.paymentStatus === 'PAID' ? 'paid' : 'awaiting a refund'}`);
    const cfg = await this.config();
    if (!cfg.onlineAvailable) throw new NotConfiguredError(`Online payments (${cfg.reason ?? 'unavailable'})`);
    const s = await this.settings.get();
    const customer = await this.customers.get(order.customerId);

    // 1. Fast path: an open, unexpired link is simply reused (no transaction, no lock).
    const reusable = await this.reusableLink(orderId);
    if (reusable) return reusable;

    // 2. Ask Razorpay for a new link WITHOUT holding a database connection: a slow or failing provider must never
    //    starve the pool (health checks and payment webhooks need it). Races are resolved in step 3.
    const minutes = Math.max(s.payments.linkExpiryMinutes, MIN_EXPIRY_MINUTES);
    const expiresAt = new Date(Date.now() + minutes * 60_000);
    const referenceId = `ORD-${order.number}-${randomBytes(3).toString('hex')}`;
    let link;
    try {
      link = await this.razorpay.createPaymentLink({
        amountCents: order.totalCents,
        currency: s.currency,
        referenceId,
        description: `${s.businessName} order #${order.number}`,
        // Only WhatsApp numbers are known to carry a country code (wa_id). A web shopper's digits are a guess, and a
        // wrong prefix could make Razorpay reject the link, so the shopper simply enters their number on Razorpay's page.
        customer: { name: customer?.name ?? order.customerName, ...(customer?.channel === 'whatsapp' && customer.phone ? { contact: customer.phone } : {}) },
        callbackUrl: `${this.publicBaseUrl.replace(/\/$/, '')}/shop/order/${order.publicToken}`,
        expireBy: expiresAt,
        notes: { order_id: order.id, order_number: String(order.number) },
      });
    } catch (err) {
      if (!(err instanceof RazorpayError)) throw err;
      this.logger.error({ status: err.status, detail: err.message }, 'razorpay payment link creation failed');
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not create the payment link right now — please try again in a moment.');
    }

    // 3. Persist under a short per-order lock, re-checking everything that may have changed while we were waiting.
    const outcome = await withTx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment-link:${orderId}`]);
      const o = await c.query<{ status: string; payment_status: string; payment_method: string }>(
        'SELECT status, payment_status, payment_method FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      const now = o.rows[0];
      if (!now || now.status === 'CANCELLED' || now.payment_status !== 'UNPAID') return { kind: 'rejected' as const };
      const open = await c.query<Payment>(`SELECT ${PAYMENT_COLS} FROM payments WHERE order_id = $1 AND status = 'CREATED'`, [orderId]);
      const current = open.rows[0];
      if (current && new Date(current.expiresAt).getTime() > Date.now() + 60_000) return { kind: 'lost' as const, payment: current };
      if (current) await c.query("UPDATE payments SET status = 'EXPIRED', updated_at = now() WHERE id = $1", [current.id]);
      const { rows } = await c.query<Payment>(
        `INSERT INTO payments (order_id, provider_ref, reference_id, status, amount_cents, currency, short_url, expires_at)
         VALUES ($1, $2, $3, 'CREATED', $4, $5, $6, $7) RETURNING ${PAYMENT_COLS}`,
        [orderId, link.id, referenceId, order.totalCents, s.currency, link.shortUrl, expiresAt]);
      if (now.payment_method !== 'ONLINE') await c.query("UPDATE orders SET payment_method = 'ONLINE', updated_at = now() WHERE id = $1", [orderId]);
      return { kind: 'created' as const, payment: rows[0]!, staleRef: current?.providerRef };
    });

    // 4. Cancel every link we won't use — outside the transaction, best effort (never leave a payable orphan if avoidable).
    const unused = outcome.kind === 'created' ? outcome.staleRef : link.id;
    if (unused) {
      await this.razorpay.cancelPaymentLink(unused)
        .catch((err: unknown) => this.logger.warn({ err: String(err), link: unused }, 'could not cancel unused payment link'));
    }
    if (outcome.kind === 'rejected') throw new ConflictError('Order can no longer be paid online (it was cancelled or paid in the meantime)');
    return outcome.payment;
  }

  /** The order's open, unexpired payment link, if any (never creates one). */
  openLink(orderId: string): Promise<Payment | undefined> {
    return this.reusableLink(orderId);
  }

  private async reusableLink(orderId: string): Promise<Payment | undefined> {
    const { rows } = await this.pool.query<Payment>(`SELECT ${PAYMENT_COLS} FROM payments WHERE order_id = $1 AND status = 'CREATED'`, [orderId]);
    const current = rows[0];
    return current && new Date(current.expiresAt).getTime() > Date.now() + 60_000 ? current : undefined;
  }

  /**
   * Order status observer. Cancelling an order that was already paid must flag the refund (it would otherwise
   * be forgotten: stock is restocked but the money stays). The notifier already told the customer.
   */
  async onOrderStatusChange(order: Order, previous: OrderStatus | null): Promise<void> {
    if (order.status !== 'CANCELLED' || previous === null) return;
    // An open link must not stay payable. Mark it locally first (so a late payment is recognised as paid-after-cancel
    // by the webhook), then cancel it at Razorpay on a best-effort basis: an outage must not block the cancellation.
    const closed = await this.pool.query<{ provider_ref: string }>(
      "UPDATE payments SET status = 'CANCELLED', updated_at = now() WHERE order_id = $1 AND status = 'CREATED' RETURNING provider_ref", [order.id]);
    if (this.razorpay.isConfigured()) {
      for (const { provider_ref } of closed.rows) {
        await this.razorpay.cancelPaymentLink(provider_ref)
          .catch((err: unknown) => this.logger.warn({ err: String(err), order: order.number }, 'could not cancel payment link at Razorpay'));
      }
    }
    // Decided on the database row, not the (possibly stale) order object, so a concurrent webhook can't be missed.
    const flagged = await this.pool.query(
      "UPDATE orders SET payment_status = 'REFUND_DUE', updated_at = now() WHERE id = $1 AND payment_status = 'PAID' RETURNING id", [order.id]);
    if (!flagged.rowCount) return;
    this.events.publish({ type: 'payment.updated', orderId: order.id, number: order.number, paymentStatus: 'REFUND_DUE' });
    const money = formatMoney(order.totalCents, (await this.settings.get()).currency);
    await this.alertStaff(`⚠️ Paid order #${order.number} (${money}) was cancelled — refund the customer in Razorpay.`);
  }

  /** Pay-link message for a customer: amount, validity, and a URL button. */
  async linkReply(order: Order, p: Payment, isNew = false): Promise<BotReply> {
    const s = await this.settings.get();
    const money = formatMoney(order.totalCents, s.currency);
    const mins = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 60_000));
    const valid = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
    return {
      text: `${isNew ? `✅ Order #${order.number} created.\n` : ''}💳 Total ${money}. Tap the button below to pay securely (UPI, card or netbanking). This link is valid for ${valid}.`,
      link: { label: `Pay ${money}`, url: p.shortUrl },
    };
  }

  /** What the chat checkout uses: online availability from live config, and the pay-link replies. */
  chatOptions(): PaymentOptions {
    const reply = async (order: Order, isNew: boolean): Promise<BotReply> => {
      try {
        return await this.linkReply(order, await this.linkForOrder(order.id), isNew);
      } catch (err) {
        if (err instanceof AppError && err.status === 409) return { text: `Sorry — ${err.message}.` };
        if (!(err instanceof AppError)) this.logger.error({ err: String(err) }, 'unexpected error creating payment link');
        return {
          text: `${isNew ? `✅ Order #${order.number} is created, but we` : 'We'} couldn't create the payment link right now. Please try again in a moment.`,
          buttons: [{ id: `paylink:${order.number}`, title: '🔁 Try again' }, { id: 'orders', title: '📦 My orders' }],
        };
      }
    };
    return {
      available: async () => {
        const cfg = await this.config();
        return { online: cfg.onlineAvailable, cod: cfg.codEnabled };
      },
      onlineCheckout: (order) => reply(order, true),
      resendLink: (order) => reply(order, false),
    };
  }

  /** Staff action: get (and optionally deliver) the pay link of an order. */
  async sendLink(orderId: string, notify: boolean): Promise<{ url: string; expiresAt: string; notified: boolean }> {
    const payment = await this.linkForOrder(orderId);
    let notified = false;
    if (notify) {
      const order = (await this.orders.get(orderId))!;
      notified = await this.sendToCustomer(order, await this.linkReply(order, payment));
    }
    return { url: payment.shortUrl, expiresAt: payment.expiresAt, notified };
  }

  /** Delivers a message on the customer's own chat channel. Returns false for web/manual customers. */
  private async sendToCustomer(order: Order, reply: BotReply): Promise<boolean> {
    if (!['whatsapp', 'messenger', 'instagram', 'telegram'].includes(order.channel)) return false;
    const customer = await this.customers.get(order.customerId);
    if (!customer?.channelUserId) return false;
    const channel = order.channel as 'whatsapp' | 'messenger' | 'instagram' | 'telegram';
    try {
      if (this.messenger.reply) await this.messenger.reply(channel, customer.channelUserId, reply);
      else await this.messenger.send(channel, customer.channelUserId, renderPlain(reply));
      return true;
    } catch (err) {
      this.logger.warn({ err: String(err), channel }, 'customer payment message failed');
      return false;
    }
  }

  /**
   * Handles a signature-verified Razorpay webhook (D-003: the only source of truth for payment state).
   * Idempotent per event id; if processing fails the id is released so Razorpay's retry runs again.
   */
  async handleWebhook(eventId: string | undefined, rawBody: Buffer | undefined, body: unknown): Promise<void> {
    const id = eventId?.trim() || `body:${createHash('sha256').update(rawBody ?? Buffer.from(JSON.stringify(body ?? null))).digest('hex')}`;
    const claimed = await this.pool.query('INSERT INTO webhook_events (provider, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['razorpay', id]);
    if (!claimed.rowCount) return; // replay
    try {
      await this.process(body);
    } catch (err) {
      await this.pool.query('DELETE FROM webhook_events WHERE provider = $1 AND event_id = $2', ['razorpay', id]);
      throw err;
    }
  }

  private async process(body: unknown): Promise<void> {
    const parsed = webhookSchema.safeParse(body);
    if (!parsed.success) return; // not an event we understand: acknowledge
    const { event, payload } = parsed.data;
    const link = payload.payment_link?.entity;
    if (!link) return;

    if (event === 'payment_link.expired' || event === 'payment_link.cancelled') {
      await this.pool.query(
        "UPDATE payments SET status = $2, updated_at = now() WHERE provider_ref = $1 AND status = 'CREATED'",
        [link.id, event === 'payment_link.expired' ? 'EXPIRED' : 'CANCELLED']);
      return;
    }
    if (event !== 'payment_link.paid') return;

    const paidCents = link.amount_paid ?? payload.payment?.entity.amount ?? 0;
    const settled = await withTx(this.pool, async (c): Promise<{ orderId: string; good: boolean; fresh: boolean; duplicate?: string } | undefined> => {
      const p = await c.query<{ id: string; order_id: string; status: string; amount_cents: number }>(
        'SELECT id, order_id, status, amount_cents FROM payments WHERE provider_ref = $1 FOR UPDATE', [link.id]);
      const payment = p.rows[0];
      if (!payment) return undefined;            // unknown link: acknowledge
      const o = await c.query<{ status: string; payment_status: string }>('SELECT status, payment_status FROM orders WHERE id = $1 FOR UPDATE', [payment.order_id]);
      const order = o.rows[0]!;
      // Already settled (a re-delivery, or a retry after a crash): don't touch money state again,
      // but report it so the confirm step below can still complete if it didn't finish last time.
      if (payment.status === 'PAID') return { orderId: payment.order_id, good: order.payment_status === 'PAID', fresh: false };
      // Did the customer already pay this order through another link? Then this is an EXTRA payment: record the money,
      // leave the order alone, and make sure a human refunds it.
      const other = await c.query("SELECT 1 FROM payments WHERE order_id = $1 AND status = 'PAID' AND id <> $2 LIMIT 1", [payment.order_id, payment.id]);
      await c.query("UPDATE payments SET status = 'PAID', provider_payment_id = $2, updated_at = now() WHERE id = $1",
        [payment.id, payload.payment?.entity.id ?? null]);
      if (other.rowCount) return { orderId: payment.order_id, good: true, fresh: true, duplicate: payload.payment?.entity.id ?? link.id };
      // Money arrived. It is only "good" if the amount matches and the order can still be fulfilled.
      const good = paidCents === payment.amount_cents && order.status !== 'CANCELLED';
      await c.query('UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1', [payment.order_id, good ? 'PAID' : 'REFUND_DUE']);
      return { orderId: payment.order_id, good, fresh: true };
    });
    if (!settled) return;

    let order = (await this.orders.get(settled.orderId))!;
    if (settled.duplicate) {
      const money = formatMoney(paidCents, (await this.settings.get()).currency);
      await this.alertStaff(`⚠️ Duplicate payment for order #${order.number}: ${settled.duplicate} (${money}) was paid after the order was already paid. Refund the extra payment in Razorpay.`);
      await this.sendToCustomer(order, { text: `We received a second payment for order #${order.number}. We'll refund the extra payment shortly.` });
      return;
    }
    if (settled.fresh) this.events.publish({ type: 'payment.updated', orderId: order.id, number: order.number, paymentStatus: order.paymentStatus });
    if (!settled.good) {
      if (!settled.fresh) return; // staff were already alerted when it was first settled
      await this.alertStaff(`⚠️ Payment received for order #${order.number} but it needs attention (amount mismatch or order cancelled). Refund due in Razorpay.`);
      await this.sendToCustomer(order, { text: REFUND_NOTICE(order.number) });
      return;
    }
    if (order.status !== 'PENDING') { // staff already confirmed it manually: confirm the payment to the customer
      if (settled.fresh) await this.sendToCustomer(order, { text: `✅ Payment received for order #${order.number}. Thank you!` });
      return;
    }
    try {
      await this.orders.confirm(order.id, undefined, null); // auto-confirm from the default warehouse
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (err instanceof ValidationError) {
        // Not a reason to refund: the shop just has no default warehouse set. The order is paid and stays PENDING
        // so staff can confirm it by hand (choosing a warehouse) — and the customer is reassured, not told to expect a refund.
        const money = formatMoney(order.totalCents, (await this.settings.get()).currency);
        await this.alertStaff(`⚠️ Order #${order.number} is PAID (${money}) but could not be auto-confirmed: no default warehouse is set. Set one in Settings, then confirm the order manually.`);
        await this.sendToCustomer(order, { text: `✅ Payment of ${money} received for order #${order.number}. We'll confirm it shortly.` });
        return;
      }
      await this.pool.query("UPDATE orders SET payment_status = 'REFUND_DUE', updated_at = now() WHERE id = $1", [order.id]);
      order = (await this.orders.get(order.id))!;
      this.events.publish({ type: 'payment.updated', orderId: order.id, number: order.number, paymentStatus: 'REFUND_DUE' });
      await this.alertStaff(`⚠️ Order #${order.number} was paid online but could not be confirmed (${err.message}). Please refund the customer in Razorpay.`);
      await this.sendToCustomer(order, { text: REFUND_NOTICE(order.number) });
    }
  }

  private async alertStaff(text: string): Promise<void> {
    const { alertRecipients } = await this.settings.get();
    for (const r of alertRecipients) {
      await this.messenger.send(r.channel, r.to, text).catch((err: unknown) => this.logger.warn({ err: String(err), channel: r.channel }, 'staff payment alert failed'));
    }
  }
}

const REFUND_NOTICE = (n: number) => `We received your payment for order #${n} but couldn't complete the order. We'll refund you shortly — sorry for the trouble.`;

// Permissive on purpose: only the fields we act on are checked (docs/3_SCHEMAS.md §3.11).
const webhookSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment_link: z.object({ entity: z.object({ id: z.string(), amount_paid: z.number().optional() }) }).optional(),
    payment: z.object({ entity: z.object({ id: z.string(), amount: z.number().optional() }) }).optional(),
  }),
});
