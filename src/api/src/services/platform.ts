import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type pg from 'pg';
import { NotFoundError, UnauthorizedError } from '../domain/errors.js';
import type { Tenant, TenantStatus } from '../domain/types.js';
import { runWithTenant } from '../db/tenant.js';
import type { AuditInput } from './audit.js';

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 4);
export interface PlatformAdmin { id: string; email: string }

/**
 * The platform console: operators who manage businesses. A separate table, a separate database role that cannot read any business table,
 * and a separate token key and type, so a business login can never act as an operator or the other way round.
 */
export class PlatformService {
  constructor(private readonly pool: pg.Pool, secret: string, private readonly expiresIn: string, private readonly rounds = 12) {
    this.key = `${secret}:platform`;
  }
  private readonly key: string;

  async bootstrapAdmin(email: string | undefined, password: string | undefined): Promise<boolean> {
    if (!email || !password) return false;
    if ((await this.pool.query('SELECT 1 FROM platform_admins LIMIT 1')).rowCount) return false;
    await this.pool.query('INSERT INTO platform_admins (email, password_hash, name) VALUES ($1, $2, $3)', [email.trim().toLowerCase(), await bcrypt.hash(password, this.rounds), 'Platform operator']);
    return true;
  }

  async login(email: string, password: string): Promise<{ token: string }> {
    const { rows } = await this.pool.query<{ id: string; email: string; password_hash: string }>('SELECT id, email, password_hash FROM platform_admins WHERE email = $1', [email.trim().toLowerCase()]);
    const found = rows[0];
    const ok = await bcrypt.compare(password, found?.password_hash ?? DUMMY_HASH);
    if (!found || !ok) throw new UnauthorizedError('Invalid email or password');
    return { token: jwt.sign({ typ: 'platform', email: found.email }, this.key, { subject: found.id, expiresIn: this.expiresIn as SignOptions['expiresIn'], algorithm: 'HS256' }) };
  }

  async authenticate(token: string): Promise<PlatformAdmin> {
    let payload: unknown;
    try { payload = jwt.verify(token, this.key, { algorithms: ['HS256'] }); } catch { throw new UnauthorizedError('Invalid or expired token'); }
    const p = typeof payload === 'object' && payload ? (payload as Record<string, unknown>) : {};
    if (p.typ !== 'platform' || typeof p.sub !== 'string') throw new UnauthorizedError('Invalid or expired token');
    const { rows } = await this.pool.query<PlatformAdmin>('SELECT id, email FROM platform_admins WHERE id = $1', [p.sub]);
    if (!rows[0]) throw new UnauthorizedError('Invalid or expired token');
    return rows[0];
  }

  async listTenants(): Promise<Tenant[]> {
    const { rows } = await this.pool.query<Tenant>('SELECT id, slug, name, status, plan, created_at AS "createdAt" FROM tenants ORDER BY created_at');
    return rows;
  }

  /** Each business with its plan, subscription state and this month's metered usage. Counters and billing state only: never a business's own records. */
  async overview(): Promise<(Tenant & { subscription: string | null; chatMessages: number; invoices: number })[]> {
    const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    const { rows } = await this.pool.query<Tenant & { subscription: string | null; chatMessages: number; invoices: number }>(
      `SELECT t.id, t.slug, t.name, t.status, t.plan, t.created_at AS "createdAt", s.status AS subscription,
              COALESCE((SELECT sum(used) FROM usage_counters u WHERE u.tenant_id = t.id AND u.metric = 'chat_messages' AND u.period = $1), 0)::int AS "chatMessages",
              COALESCE((SELECT sum(used) FROM usage_counters u WHERE u.tenant_id = t.id AND u.metric = 'invoices' AND u.period = $1), 0)::int AS invoices
       FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id ORDER BY t.created_at`, [period]);
    return rows;
  }

  /** Leaves a line in a business's own audit trail (write-only: the platform role cannot read it back). */
  async audit(tenantId: string, admin: PlatformAdmin, e: Pick<AuditInput, 'action' | 'entity' | 'entityId' | 'detail'>): Promise<void> {
    await runWithTenant(tenantId, () => this.pool.query(
      'INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5)',
      [`platform:${admin.email}`, e.action, e.entity ?? 'tenants', e.entityId ?? tenantId, JSON.stringify(e.detail ?? {})]));
  }

  /** Businesses whose background work should run. */
  async activeTenantIds(): Promise<string[]> {
    return (await this.pool.query<{ id: string }>("SELECT id FROM tenants WHERE status = 'ACTIVE'")).rows.map((r) => r.id);
  }

  /** Whole-platform queue health: all businesses together, plus the workers' heartbeats (no payloads, no business data). */
  async queueOverview(): Promise<{ queue: { pending: number; running: number; dead: number; oldestPendingSec: number }; workers: { workerId: string; seenAt: string }[] }> {
    const [counts, oldest, workers] = await Promise.all([
      this.pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM jobs GROUP BY status'),
      this.pool.query<{ age: number }>("SELECT COALESCE(floor(GREATEST(0, extract(epoch FROM now() - min(run_at)))), 0)::int AS age FROM jobs WHERE status = 'pending' AND run_at <= now()"),
      this.pool.query<{ workerId: string; seenAt: string }>('SELECT worker_id AS "workerId", seen_at AS "seenAt" FROM worker_heartbeats ORDER BY worker_id'),
    ]);
    const n = (s: string) => counts.rows.find((r) => r.status === s)?.n ?? 0;
    return { queue: { pending: n('pending'), running: n('running'), dead: n('dead'), oldestPendingSec: oldest.rows[0]?.age ?? 0 }, workers: workers.rows };
  }

  async setStatus(id: string, status: Extract<TenantStatus, 'ACTIVE' | 'SUSPENDED'>): Promise<Tenant> {
    const { rows } = await this.pool.query<Tenant>('UPDATE tenants SET status = $2 WHERE id = $1 RETURNING id, slug, name, status, plan, created_at AS "createdAt"', [id, status]);
    if (!rows[0]) throw new NotFoundError('Business');
    return rows[0];
  }
}
