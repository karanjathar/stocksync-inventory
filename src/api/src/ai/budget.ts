import type { Queryable } from '../db/pool.js';
import { AppError } from '../domain/errors.js';

/** The business used up its AI allowance for the month (or its plan has none). Nothing else is affected. */
export class AiBudgetError extends AppError {
  constructor(details: { limit: number; used: number; plan: string }) {
    super(402, 'AI_BUDGET', details.limit === 0 ? `AI assistance is not part of your ${details.plan} plan.` : `Your ${details.plan} plan's AI allowance for this month is used up.`, details);
  }
}

/** One unit is an input token or five output tokens, so the allowance follows cost whichever model is used. */
export const unitsFor = (inputTokens: number, outputTokens: number): number => inputTokens + 5 * outputTokens;
const month = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Monthly AI allowance per business. `reserve` takes the WORST CASE units of a call before it is made, in one conditional upsert (concurrent calls
 * cannot overshoot), and `settle` returns the unused part afterwards and records the real tokens. If a call fails, `release` gives everything back.
 */
export class AiBudget {
  constructor(private readonly db: Queryable) {}

  async plan(): Promise<{ name: string; limit: number }> {
    const r = (await this.db.query<{ name: string; limit: string }>(
      'SELECT p.name, p.ai_monthly_units::text AS "limit" FROM plans p JOIN tenants t ON t.plan = p.code WHERE t.id = current_tenant()')).rows[0];
    return { name: r?.name ?? 'Free', limit: Number(r?.limit ?? 0) };
  }

  async reserve(units: number): Promise<void> {
    const plan = await this.plan();
    const { rowCount } = await this.db.query(
      `INSERT INTO ai_usage (period, units) SELECT $1, $2 WHERE $2::bigint <= $3::bigint
       ON CONFLICT (tenant_id, period) DO UPDATE SET units = ai_usage.units + $2 WHERE ai_usage.units + $2 <= $3`, [month(), units, plan.limit]);
    if (!rowCount) throw new AiBudgetError({ limit: plan.limit, used: (await this.used()).units, plan: plan.name });
  }

  async settle(reserved: number, actual: { inputTokens: number; outputTokens: number }): Promise<void> {
    const used = unitsFor(actual.inputTokens, actual.outputTokens);
    await this.db.query(
      'UPDATE ai_usage SET units = greatest(0, units - $2 + $3), input_tokens = input_tokens + $4, output_tokens = output_tokens + $5, calls = calls + 1 WHERE period = $1',
      [month(), reserved, used, actual.inputTokens, actual.outputTokens]);
  }

  async release(reserved: number): Promise<void> {
    await this.db.query('UPDATE ai_usage SET units = greatest(0, units - $2) WHERE period = $1', [month(), reserved]);
  }

  async used(): Promise<{ units: number; calls: number; inputTokens: number; outputTokens: number }> {
    const r = (await this.db.query<{ units: string; calls: number; i: string; o: string }>(
      'SELECT units::text, calls, input_tokens::text AS i, output_tokens::text AS o FROM ai_usage WHERE period = $1', [month()])).rows[0];
    return { units: Number(r?.units ?? 0), calls: r?.calls ?? 0, inputTokens: Number(r?.i ?? 0), outputTokens: Number(r?.o ?? 0) };
  }
}
