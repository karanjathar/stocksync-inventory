import type { Queryable } from '../db/pool.js';
import { NotFoundError, PlanLimitError, ValidationError } from '../domain/errors.js';

export interface Plan {
  code: string; name: string; priceMinor: number; currency: string; active: boolean; sort: number;
  maxProducts: number | null; maxUsers: number | null; maxChatMessages: number | null; maxInvoices: number | null;
}
export type Metered = 'chat_messages' | 'invoices';
export type Counted = 'products' | 'users';
export interface Usage { plan: Plan; period: string; usage: { products: number; users: number; chatMessages: number; invoices: number } }

const PLAN_SELECT = `SELECT code, name, price_minor AS "priceMinor", currency, active, sort, max_products AS "maxProducts", max_users AS "maxUsers",
  max_chat_messages AS "maxChatMessages", max_invoices AS "maxInvoices" FROM plans`;
const MONTH = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** Plans and what the current business has used of them. Limits only ever stop new records; existing data is never touched. */
export class PlansService {
  constructor(private readonly db: Queryable) {}

  async listActive(): Promise<Plan[]> { return (await this.db.query<Plan>(`${PLAN_SELECT} WHERE active ORDER BY sort`)).rows; }

  /** The current business's plan. */
  async current(db: Queryable = this.db): Promise<Plan> {
    const { rows } = await db.query<Plan>(`${PLAN_SELECT} WHERE code = (SELECT plan FROM tenants WHERE id = current_tenant())`);
    if (!rows[0]) throw new NotFoundError('Plan');
    return rows[0];
  }

  async usage(): Promise<Usage> {
    const period = MONTH();
    const [plan, products, users, counters] = await Promise.all([
      this.current(),
      this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM products'),
      this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM users'),
      this.db.query<{ metric: string; used: number }>('SELECT metric, used FROM usage_counters WHERE period = $1', [period]),
    ]);
    const used = (m: Metered) => counters.rows.find((r) => r.metric === m)?.used ?? 0;
    return { plan, period, usage: { products: products.rows[0]!.n, users: users.rows[0]!.n, chatMessages: used('chat_messages'), invoices: used('invoices') } };
  }

  /** Throws PLAN_LIMIT when one more product or user would exceed the plan. */
  async assertCanAdd(kind: Counted): Promise<void> {
    const plan = await this.current();
    const limit = kind === 'products' ? plan.maxProducts : plan.maxUsers;
    if (limit === null) return;
    const used = (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${kind}`)).rows[0]!.n;
    if (used >= limit) throw new PlanLimitError({ metric: kind, limit, used, plan: plan.name });
  }

  /**
   * Counts one unit of a monthly metric, atomically and only while under the limit (one conditional upsert, so concurrent callers can never
   * overshoot). Returns ok:false, changing nothing, when the limit is reached. Pass a transaction client to roll the count back with the work.
   */
  async consume(metric: Metered, db: Queryable = this.db): Promise<{ ok: true } | { ok: false; limit: number; used: number; plan: string }> {
    const plan = await this.current(db);
    const limit = metric === 'chat_messages' ? plan.maxChatMessages : plan.maxInvoices;
    const period = MONTH();
    const { rowCount } = await db.query(
      `INSERT INTO usage_counters (metric, period, used) SELECT $1, $2, 1 WHERE $3::int IS NULL OR $3::int > 0
       ON CONFLICT (tenant_id, metric, period) DO UPDATE SET used = usage_counters.used + 1 WHERE $3::int IS NULL OR usage_counters.used < $3::int`,
      [metric, period, limit]);
    if (rowCount) return { ok: true };
    const used = (await db.query<{ used: number }>('SELECT used FROM usage_counters WHERE metric = $1 AND period = $2', [metric, period])).rows[0]?.used ?? 0;
    return { ok: false, limit: limit ?? 0, used, plan: plan.name };
  }

  /** consume(), turned into the PLAN_LIMIT error for callers that must stop. */
  async consumeOrThrow(metric: Metered, db: Queryable = this.db): Promise<void> {
    const r = await this.consume(metric, db);
    if (!r.ok) throw new PlanLimitError({ metric, limit: r.limit, used: r.used, plan: r.plan });
  }
}

export interface PlanEdit {
  name?: string; priceMinor?: number; active?: boolean; sort?: number;
  maxProducts?: number | null; maxUsers?: number | null; maxChatMessages?: number | null; maxInvoices?: number | null;
}
const COLS: Record<keyof PlanEdit, string> = { name: 'name', priceMinor: 'price_minor', active: 'active', sort: 'sort', maxProducts: 'max_products', maxUsers: 'max_users', maxChatMessages: 'max_chat_messages', maxInvoices: 'max_invoices' };

/** Platform operator's side: edit plans without a deploy (runs on the platform role, which sees plans and tenants only). */
export class PlanAdmin {
  constructor(private readonly db: Queryable) {}
  async list(): Promise<Plan[]> { return (await this.db.query<Plan>(`${PLAN_SELECT} ORDER BY sort`)).rows; }
  async upsert(code: string, edit: PlanEdit): Promise<Plan> {
    const keys = (Object.keys(COLS) as (keyof PlanEdit)[]).filter((k) => edit[k] !== undefined);
    if (!keys.length) throw new ValidationError('Nothing to change');
    const cols = keys.map((k) => COLS[k]);
    const exists = (await this.db.query('SELECT 1 FROM plans WHERE code = $1', [code])).rowCount;
    if (exists) await this.db.query(`UPDATE plans SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE code = $1`, [code, ...keys.map((k) => edit[k])]);
    else {
      if (edit.name === undefined) throw new ValidationError('A new plan needs a name');
      await this.db.query(`INSERT INTO plans (code, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`, [code, ...keys.map((k) => edit[k])]);
    }
    return (await this.db.query<Plan>(`${PLAN_SELECT} WHERE code = $1`, [code])).rows[0]!;
  }
  async assign(tenantId: string, code: string): Promise<void> {
    if (!(await this.db.query('SELECT 1 FROM plans WHERE code = $1 AND active', [code])).rowCount) throw new ValidationError('Unknown or inactive plan');
    if (!(await this.db.query('UPDATE tenants SET plan = $2 WHERE id = $1', [tenantId, code])).rowCount) throw new NotFoundError('Business');
  }
}
