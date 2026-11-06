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

export class RazorpayError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Razorpay API responded ${status}: ${detail}`);
    this.name = 'RazorpayError';
  }
}

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

  async cancelPaymentLink(id: string): Promise<void> {
    await this.post(`/v1/payment_links/${encodeURIComponent(id)}/cancel`, {});
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const auth = Buffer.from(`${this.cfg.keyId ?? ''}:${this.cfg.keySecret ?? ''}`).toString('base64');
    const res = await this.fetchFn(`${this.cfg.apiBase.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
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
