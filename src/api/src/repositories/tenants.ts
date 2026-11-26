import type { Queryable } from '../db/pool.js';
import type { Tenant, TenantStatus } from '../domain/types.js';

/** The current tenant's own row (row-level security shows a business nothing else). */
export class TenantsRepo {
  constructor(private readonly db: Queryable) {}

  async currentStatus(): Promise<TenantStatus | undefined> {
    const { rows } = await this.db.query<{ status: TenantStatus }>('SELECT status FROM tenants WHERE id = current_tenant()');
    return rows[0]?.status;
  }

  async current(): Promise<Tenant | undefined> {
    const { rows } = await this.db.query<Tenant>('SELECT id, slug, name, status, plan, created_at AS "createdAt" FROM tenants WHERE id = current_tenant()');
    return rows[0];
  }
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Finds a business from a public slug or an unguessable link before any tenant context exists (narrow SECURITY DEFINER lookups; ACTIVE only). */
export class TenantDirectory {
  constructor(private readonly db: Queryable) {}

  async bySlug(slug: string): Promise<{ id: string; slug: string; name: string } | undefined> {
    if (!SLUG_RE.test(slug)) return undefined;
    return (await this.db.query<{ id: string; slug: string; name: string }>('SELECT id, slug, name FROM tenant_by_slug($1)', [slug])).rows[0];
  }

  async ofOrderToken(token: string): Promise<string | undefined> {
    return (await this.db.query<{ id: string | null }>('SELECT tenant_of_order_token($1::uuid) AS id', [token])).rows[0]?.id ?? undefined;
  }

  async ofInvoice(invoiceId: string): Promise<string | undefined> {
    return (await this.db.query<{ id: string | null }>('SELECT tenant_of_invoice($1::uuid) AS id', [invoiceId])).rows[0]?.id ?? undefined;
  }
}

