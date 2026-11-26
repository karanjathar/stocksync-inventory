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
