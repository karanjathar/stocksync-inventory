import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Razorpay Payment Links API (docs/3_SCHEMAS.md §3.11). */
export interface RazorpayConfig { keyId?: string; keySecret?: string; webhookSecret?: string; apiBase: string }

export interface CreateLinkInput {
  amountCents: number;          // paise; always computed server-side from the order
  currency: string;
  referenceId: string;
  description: string;
  customer: { name: string; contact?: string };
  callbackUrl: string;
  expireBy: Date;
  notes: Record<string, string>;
}
export interface PaymentLink { id: string; shortUrl: string; status: string }

/** Supplies the Razorpay client of the CURRENT business (its own keys), at call time. */
export interface RazorpayProvider { client(): Promise<RazorpayClient> }

export class RazorpayError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Razorpay API responded ${status}: ${detail}`);
    this.name = 'RazorpayError';
  }
}

export interface RefundInput { paymentId: string; amountCents: number; receipt: string; idempotencyKey: string; notes?: Record<string, string> }
export interface Refund { id: string; status: string; amountCents: number }

const refundResponse = z.object({ id: z.string().startsWith('rfnd_'), status: z.string(), amount: z.number().int() });
const linkResponse = z.object({ id: z.string().startsWith('plink_'), short_url: z.string().url(), status: z.string() });

export class RazorpayClient {
  constructor(private readonly cfg: RazorpayConfig, private readonly fetchFn: typeof fetch) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.keyId && this.cfg.keySecret && this.cfg.webhookSecret);
  }

  get webhookSecret(): string | undefined { return this.cfg.webhookSecret; }
  get keySecret(): string | undefined { return this.cfg.keySecret; }

  async createPaymentLink(i: CreateLinkInput): Promise<PaymentLink> {
    const json = await this.post('/v1/payment_links', {
      amount: i.amountCents,
      currency: i.currency,
      accept_partial: false,
      reference_id: i.referenceId,
      description: i.description.slice(0, 2048),
      customer: { name: i.customer.name, ...(i.customer.contact ? { contact: i.customer.contact } : {}) },
      notify: { sms: false, email: false },   // we deliver the link ourselves (chat or redirect)
      reminder_enable: false,
      notes: i.notes,
      callback_url: i.callbackUrl,
      callback_method: 'get',
      expire_by: Math.floor(i.expireBy.getTime() / 1000),
    });
    const parsed = linkResponse.safeParse(json);
    if (!parsed.success) throw new RazorpayError(502, 'unexpected response from Payment Links API');
    return { id: parsed.data.id, shortUrl: parsed.data.short_url, status: parsed.data.status };
  }

  /**
   * Refunds a captured payment (POST /v1/payments/{id}/refund). `idempotencyKey` is sent as X-Refund-Idempotency so a retried call cannot refund twice.
   * The final outcome arrives by signed webhook (`refund.processed` / `refund.failed`); the status returned here is only the first answer.
   */
  async refundPayment(i: RefundInput): Promise<Refund> {
    if (!/^pay_[A-Za-z0-9_]+$/.test(i.paymentId)) throw new RazorpayError(400, 'not a Razorpay payment id');
    if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) throw new RazorpayError(400, 'refund amount must be a positive whole number of paise');
    const json = await this.post(`/v1/payments/${i.paymentId}/refund`, { amount: i.amountCents, speed: 'normal', receipt: i.receipt.slice(0, 40), notes: i.notes ?? {} },
      { 'x-refund-idempotency': i.idempotencyKey });
    const parsed = refundResponse.safeParse(json);
    if (!parsed.success) throw new RazorpayError(502, 'unexpected response from Refunds API');
    return { id: parsed.data.id, status: parsed.data.status, amountCents: parsed.data.amount };
  }

  async cancelPaymentLink(id: string): Promise<void> {
    await this.post(`/v1/payment_links/${encodeURIComponent(id)}/cancel`, {});
  }

  private async post(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const auth = Buffer.from(`${this.cfg.keyId ?? ''}:${this.cfg.keySecret ?? ''}`).toString('base64');
    const res = await this.fetchFn(`${this.cfg.apiBase.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const description = (json as { error?: { description?: string } }).error?.description ?? res.statusText;
      throw new RazorpayError(res.status, String(description).slice(0, 300));
    }
    return json;
  }
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** X-Razorpay-Signature = hex(HMAC-SHA256(raw request body, webhook secret)). */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined, secret: string): boolean {
  if (!rawBody || !signature || !secret) return false;
  return safeEqualHex(signature, createHmac('sha256', secret).update(rawBody).digest('hex'));
}

/** Redirect callback signature — UX only, never used to change payment state (D-003). */
export function verifyCallbackSignature(
  p: { paymentLinkId: string; referenceId: string; status: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  if (!p.signature || !keySecret) return false;
  const expected = createHmac('sha256', keySecret).update(`${p.paymentLinkId}|${p.referenceId}|${p.status}|${p.paymentId}`).digest('hex');
  return safeEqualHex(p.signature, expected);
}
