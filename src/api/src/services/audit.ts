import type { Queryable } from '../db/pool.js';

export interface AuditEntry { id: string; at: string; actorId: string | null; actor: string; action: string; entity: string | null; entityId: string | null; detail: Record<string, unknown>; ip: string | null }
export interface AuditInput { actorId: string | null; actor: string; action: string; entity?: string | null; entityId?: string | null; detail?: Record<string, unknown>; ip?: string | null }

/** Values that are safe and useful to keep. Everything else in a request body is recorded by field NAME only (never passwords, tokens or personal data). */
const SAFE_VALUE_KEYS = new Set(['priceCents', 'role', 'status', 'quantity', 'newQuantity', 'delta', 'plan', 'currency', 'businessName', 'defaultWarehouseId', 'isActive', 'dismissed', 'kind', 'reason', 'amountCents']);

/** What a request changed, without its secrets: field names, plus the values of a short allow-list. */
export function summariseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const keys = Object.keys(body).slice(0, 40);
  const out: Record<string, unknown> = { fields: keys };
  const values: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (body as Record<string, unknown>)[k];
    if (SAFE_VALUE_KEYS.has(k) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 120))) values[k] = v;
  }
  if (Object.keys(values).length) out.values = values;
  return out;
}

const like = (v: string) => `%${v.replace(/[%_\\]/g, '\\$&')}%`;

export class AuditService {
  constructor(private readonly db: Queryable) {}

  async record(e: AuditInput): Promise<void> {
    await this.db.query('INSERT INTO audit_log (actor_id, actor, action, entity, entity_id, detail, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [e.actorId, e.actor.slice(0, 320), e.action.slice(0, 200), e.entity ?? null, e.entityId ?? null, JSON.stringify(e.detail ?? {}), e.ip ?? null]);
  }

  /** Newest first. `before` is the `at|id` cursor of the last row of the previous page. */
  async list(o: { limit: number; before?: string; action?: string; actor?: string }): Promise<{ entries: AuditEntry[]; next: string | null }> {
    const args: unknown[] = [];
    const where: string[] = [];
    if (o.before) {
      const [at, id] = o.before.split('|');
      args.push(at, id); where.push(`(at, id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`);
    }
    if (o.action) { args.push(like(o.action)); where.push(`action ILIKE $${args.length}`); }
    if (o.actor) { args.push(like(o.actor)); where.push(`actor ILIKE $${args.length}`); }
    args.push(o.limit + 1);
    const { rows } = await this.db.query<AuditEntry & { atRaw: string }>(
      `SELECT id, at, at::text AS "atRaw", actor_id AS "actorId", actor, action, entity, entity_id AS "entityId", detail, ip FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $${args.length}`, args);
    const page = rows.slice(0, o.limit);
    const last = page.at(-1);
    return { entries: page.map(({ atRaw: _a, ...e }) => e), next: rows.length > o.limit && last ? `${last.atRaw}|${last.id}` : null };
  }
}
