import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { Queryable } from '../db/pool.js';
import { ConflictError, NotConfiguredError, NotFoundError } from '../domain/errors.js';
import type { RazorpaySubscriptions, SubscriptionEvent } from '../payments/razorpaySubscriptions.js';
import type { PlansService } from './plans.js';

export type SubscriptionStatus = 'CREATED' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';
export interface SubscriptionView {
  status: SubscriptionStatus; planCode: string; pendingPlanCode: string | null; trialEndsAt: string | null; currentPeriodEnd: string | null;
  graceEndsAt: string | null; cancelAtPeriodEnd: boolean; shortUrl: string | null;
}
export interface BillingState {
  configured: boolean; plan: { code: string; name: string }; subscription: SubscriptionView | null; trialDays: number; trialAvailable: boolean;
  offers: { code: string; name: string; priceMinor: number; currency: string }[];
}

const SUB_SELECT = `SELECT status, plan_code AS "planCode", pending_plan_code AS "pendingPlanCode", trial_ends_at AS "trialEndsAt", current_period_end AS "currentPeriodEnd",
  grace_ends_at AS "graceEndsAt", cancel_at_period_end AS "cancelAtPeriodEnd", short_url AS "shortUrl", trial_used AS "trialUsed" FROM subscriptions`;
const LIVE = new Set<SubscriptionStatus>(['TRIAL', 'ACTIVE', 'PAST_DUE']);

/** The business's side: subscribe, change plan, cancel. It asks Razorpay and records the request; the plan itself changes only from webhooks. */
export class BillingService {
  constructor(private readonly db: Queryable, private readonly plans: PlansService, private readonly provider: RazorpaySubscriptions, private readonly trialDays: number) {}

  private async row(): Promise<(SubscriptionView & { trialUsed: boolean; }) | undefined> {
    return (await this.db.query<SubscriptionView & { trialUsed: boolean }>(`${SUB_SELECT} WHERE tenant_id = current_tenant()`)).rows[0];
  }

  async state(): Promise<BillingState> {
    const [plan, sub, offers] = await Promise.all([this.plans.current(), this.row(), this.plans.listActive()]);
    const { trialUsed: _t, ...subscription } = sub ?? ({} as never);
    return {
      configured: this.provider.isConfigured(), plan: { code: plan.code, name: plan.name }, subscription: sub ? subscription : null, trialDays: this.trialDays,
      trialAvailable: !sub?.trialUsed && this.trialDays > 0,
      offers: offers.filter((p) => p.priceMinor > 0 && p.razorpayPlanId).map((p) => ({ code: p.code, name: p.name, priceMinor: p.priceMinor, currency: p.currency })),
    };
  }

  /** The Razorpay plan id and price are read from OUR plan record by code; nothing about price or plan id is accepted from the caller. */
  private async offer(code: string): Promise<{ code: string; razorpayPlanId: string }> {
    const plan = (await this.plans.listActive()).find((p) => p.code === code);
    if (!plan || plan.priceMinor <= 0 || !plan.razorpayPlanId) throw new ConflictError('That plan is not available for subscription');
    return { code: plan.code, razorpayPlanId: plan.razorpayPlanId };
  }

  async subscribe(planCode: string, tenantId: string): Promise<{ shortUrl: string; trialEndsAt: string | null }> {
    if (!this.provider.isConfigured()) throw new NotConfiguredError('Billing');
    const offer = await this.offer(planCode);
    const current = await this.row();
    if (current && LIVE.has(current.status)) throw new ConflictError('You already have a subscription. Change or cancel it instead.');
    const startAt = !current?.trialUsed && this.trialDays > 0 ? new Date(Date.now() + this.trialDays * 86_400_000) : undefined;
    const sub = await this.provider.create({ planId: offer.razorpayPlanId, tenantId, ...(startAt ? { startAt } : {}) });
    await this.db.query('SELECT billing_register($1, $2, $3, $4)', [sub.id, offer.code, sub.shortUrl, startAt ?? null]);
    return { shortUrl: sub.shortUrl, trialEndsAt: startAt?.toISOString() ?? null };
  }

  async changePlan(planCode: string): Promise<void> {
    if (!this.provider.isConfigured()) throw new NotConfiguredError('Billing');
    const sub = await this.subscriptionId();
    const offer = await this.offer(planCode);
    await this.provider.changePlan(sub, offer.razorpayPlanId);
    await this.db.query('SELECT billing_note_request($1, false)', [offer.code]);
  }

  async cancel(): Promise<void> {
    if (!this.provider.isConfigured()) throw new NotConfiguredError('Billing');
    await this.provider.cancel(await this.subscriptionId());
    await this.db.query('SELECT billing_note_request(NULL, true)');
  }

  private async subscriptionId(): Promise<string> {
    const { rows } = await this.db.query<{ id: string; status: SubscriptionStatus }>(
      'SELECT razorpay_subscription_id AS id, status FROM subscriptions WHERE tenant_id = current_tenant()');
    if (!rows[0] || !LIVE.has(rows[0].status)) throw new NotFoundError('Subscription');
    return rows[0].id;
  }
}

/**
 * The platform's side: applies signed subscription.* webhooks (one per event id) and ends expired grace periods. Runs on the platform role, which sees
 * tenants, plans and subscriptions only. Plan codes come from our own plan records matched by Razorpay plan id, never from notes or the client.
 */
export class BillingWebhooks {
  constructor(private readonly pool: pg.Pool, private readonly graceDays: number, private readonly logger: Logger) {}

  async handle(eventIdHeader: string | undefined, raw: Buffer | undefined, ev: SubscriptionEvent): Promise<'applied' | 'duplicate' | 'ignored'> {
    const eventId = eventIdHeader || `body:${createHash('sha256').update(raw ?? JSON.stringify(ev)).digest('hex')}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const fresh = await client.query('INSERT INTO billing_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
      if (!fresh.rowCount) { await client.query('ROLLBACK'); return 'duplicate'; }
      const sub = (await client.query<{ tenantId: string; planCode: string; status: SubscriptionStatus; trialEndsAt: string | null; graceEndsAt: string | null }>(
        `SELECT tenant_id AS "tenantId", plan_code AS "planCode", status, trial_ends_at AS "trialEndsAt", grace_ends_at AS "graceEndsAt"
         FROM subscriptions WHERE razorpay_subscription_id = $1 FOR UPDATE`, [ev.subscriptionId])).rows[0];
      if (!sub) { await client.query('COMMIT'); return 'ignored'; } // not one of ours (or already replaced)
      const billed = ev.planId ? (await client.query<{ code: string }>('SELECT code FROM plans WHERE razorpay_plan_id = $1', [ev.planId])).rows[0]?.code : undefined;
      const plan = billed ?? sub.planCode;
      const set = async (status: SubscriptionStatus, tenantPlan: string | null, extra: { grace?: 'start' | 'clear'; periodEnd?: Date } = {}) => {
        await client.query(
          `UPDATE subscriptions SET status = $2, plan_code = $3, pending_plan_code = CASE WHEN $2 IN ('ACTIVE', 'CANCELLED', 'EXPIRED') THEN NULL ELSE pending_plan_code END,
             current_period_end = COALESCE($4::timestamptz, current_period_end),
             grace_ends_at = CASE $5 WHEN 'clear' THEN NULL WHEN 'start' THEN COALESCE(grace_ends_at, now() + make_interval(days => $6)) ELSE grace_ends_at END, updated_at = now()
           WHERE tenant_id = $1`, [sub.tenantId, status, plan, extra.periodEnd ?? null, extra.grace ?? 'keep', this.graceDays]);
        if (tenantPlan) await client.query('UPDATE tenants SET plan = $2 WHERE id = $1', [sub.tenantId, tenantPlan]);
      };
      switch (ev.event) {
        case 'subscription.authenticated':
          if (sub.trialEndsAt && new Date(sub.trialEndsAt) > new Date() && sub.status === 'CREATED') await set('TRIAL', plan, { grace: 'clear' });
          break;
        case 'subscription.activated': case 'subscription.charged': case 'subscription.resumed':
          await set('ACTIVE', plan, { grace: 'clear', ...(ev.currentEnd ? { periodEnd: ev.currentEnd } : {}) });
          break;
        case 'subscription.pending': case 'subscription.halted':
          if (sub.status !== 'CANCELLED' && sub.status !== 'EXPIRED') await set('PAST_DUE', null, { grace: 'start' }); // paid features stay until the grace period ends
          break;
        case 'subscription.cancelled': case 'subscription.completed':
          await set('CANCELLED', 'FREE', { grace: 'clear' });
          break;
        default: // updated, paused, ...: recorded as seen, no state change
      }
      await client.query('COMMIT');
      return 'applied';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err; // the event id was rolled back too, so Razorpay's retry is processed
    } finally {
      client.release();
    }
  }

  /** Businesses whose payment stayed unpaid past the grace period go back to Free. Their data stays; only adding beyond Free limits is blocked. */
  async expireGrace(): Promise<number> {
    const { rows } = await this.pool.query<{ tenantId: string }>(
      `UPDATE subscriptions SET status = 'EXPIRED', pending_plan_code = NULL, updated_at = now()
       WHERE status = 'PAST_DUE' AND grace_ends_at < now() RETURNING tenant_id AS "tenantId"`);
    for (const r of rows) {
      await this.pool.query("UPDATE tenants SET plan = 'FREE' WHERE id = $1", [r.tenantId]);
      this.logger.warn({ tenantId: r.tenantId }, 'subscription grace period ended: business moved to Free');
    }
    return rows.length;
  }
}
