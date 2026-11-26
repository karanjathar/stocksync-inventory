import { z } from 'zod';
import { RazorpayError, verifyWebhookSignature } from './razorpay.js';

export { verifyWebhookSignature };
/** The PLATFORM's Razorpay account (it bills businesses for their plan). Not any business's own payment keys. */
export interface SubscriptionsConfig { keyId?: string; keySecret?: string; webhookSecret?: string; apiBase: string }
export interface CreatedSubscription { id: string; status: string; shortUrl: string }

const created = z.object({ id: z.string().startsWith('sub_'), status: z.string(), short_url: z.string().url() });

/** Razorpay Subscriptions API. Plan ids come from our own records; no amount is ever sent (the Razorpay plan carries it). */
export class RazorpaySubscriptions {
  constructor(private readonly cfg: SubscriptionsConfig, private readonly fetchFn: typeof fetch) {}

  isConfigured(): boolean { return Boolean(this.cfg.keyId && this.cfg.keySecret && this.cfg.webhookSecret); }
  get webhookSecret(): string | undefined { return this.cfg.webhookSecret; }

  /** `startAt` in the future gives a trial: the first charge happens then. `totalCount` is the number of billing cycles (a long, renewable horizon). */
  async create(i: { planId: string; tenantId: string; startAt?: Date; totalCount?: number }): Promise<CreatedSubscription> {
    const json = await this.call('POST', '/v1/subscriptions', {
      plan_id: i.planId, total_count: i.totalCount ?? 120, quantity: 1, customer_notify: 1,
      ...(i.startAt ? { start_at: Math.floor(i.startAt.getTime() / 1000) } : {}), notes: { tenant_id: i.tenantId },
    });
    const parsed = created.safeParse(json);
    if (!parsed.success) throw new RazorpayError(502, 'unexpected response from Subscriptions API');
    return { id: parsed.data.id, status: parsed.data.status, shortUrl: parsed.data.short_url };
  }

  /** Takes effect at the end of the paid period (the business keeps what it paid for). */
  async cancel(subscriptionId: string): Promise<void> {
    await this.call('POST', `/v1/subscriptions/${this.id(subscriptionId)}/cancel`, { cancel_at_cycle_end: 1 });
  }

  async changePlan(subscriptionId: string, planId: string): Promise<void> {
    await this.call('PATCH', `/v1/subscriptions/${this.id(subscriptionId)}`, { plan_id: planId, schedule_change_at: 'cycle_end', quantity: 1 });
  }

  private id(v: string): string {
    if (!/^sub_[A-Za-z0-9]+$/.test(v)) throw new RazorpayError(400, 'not a Razorpay subscription id');
    return v;
  }

  private async call(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<unknown> {
    if (!this.isConfigured()) throw new RazorpayError(501, 'platform billing is not configured');
    const auth = Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString('base64');
    const res = await this.fetchFn(`${this.cfg.apiBase.replace(/\/$/, '')}${path}`, {
      method, headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new RazorpayError(res.status, String((json as { error?: { description?: string } }).error?.description ?? res.statusText).slice(0, 300));
    return json;
  }
}

const eventSchema = z.object({
  event: z.string(),
  payload: z.object({ subscription: z.object({ entity: z.object({
    id: z.string().startsWith('sub_'), plan_id: z.string().optional(), status: z.string().optional(), current_end: z.number().int().nullable().optional(),
  }) }) }),
});
export type SubscriptionEvent = { event: string; subscriptionId: string; planId?: string; currentEnd?: Date };
/** Undefined for anything that is not a subscription event we understand. */
export function parseSubscriptionEvent(body: unknown): SubscriptionEvent | undefined {
  const p = eventSchema.safeParse(body);
  if (!p.success || !p.data.event.startsWith('subscription.')) return undefined;
  const e = p.data.payload.subscription.entity;
  return { event: p.data.event, subscriptionId: e.id, ...(e.plan_id ? { planId: e.plan_id } : {}), ...(e.current_end ? { currentEnd: new Date(e.current_end * 1000) } : {}) };
}
