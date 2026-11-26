import pg from 'pg';
import { currentTenantId } from './tenant.js';

// Return timestamps as ISO strings and bigint/numeric aggregates as numbers (values stay well below 2^53).
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export interface PoolOptions {
  connectionString: string;
  ssl: boolean;
  max?: number;
  /**
   * Run every connection as this restricted role (non-owner, no BYPASSRLS) so row-level security applies, and set the tenant of the current
   * request on it (docs/3_SCHEMAS.md 3.22). Without it the pool is the unrestricted owner pool: migrations and platform code only.
   */
  appRole?: string;
  /** Tenant used when no tenant context is active. Temporary single-tenant compatibility (tests, jobs and webhooks until they resolve their own tenant). */
  fallbackTenantId?: string;
}

export type Queryable = Pick<pg.Pool, 'query'>;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function createPool({ connectionString, ssl, max = 10, appRole, fallbackTenantId }: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    // Azure Database for PostgreSQL requires TLS; certificates are validated.
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
  });
  if (!appRole) return pool;

  // Per physical connection: which role it was switched to and which tenant it is currently bound to.
  const roleReady = new WeakSet<pg.PoolClient>();
  const boundTo = new WeakMap<pg.PoolClient, string>();
  const rawConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;

  /** Switches the connection to the restricted role (once) and to the tenant of the current context. Fails closed: any error discards the connection. */
  const bind = async (client: pg.PoolClient): Promise<void> => {
    try {
      if (!roleReady.has(client)) { await client.query(`SET ROLE ${quoteIdent(appRole)}`); roleReady.add(client); }
      const want = currentTenantId() ?? fallbackTenantId ?? '';
      if (boundTo.get(client) !== want) { await client.query("SELECT set_config('app.tenant_id', $1, false)", [want]); boundTo.set(client, want); }
    } catch (err) {
      client.release(err instanceof Error ? err : new Error(String(err))); // a connection in an unknown state is destroyed, never reused
      throw err;
    }
  };

  const scopedConnect = async (): Promise<pg.PoolClient> => {
    const client = await rawConnect();
    await bind(client);
    return client;
  };
  const scopedQuery = async (...args: unknown[]): Promise<pg.QueryResult> => {
    if (typeof args[args.length - 1] === 'function') throw new TypeError('callback-style pool.query is not supported: it would bypass tenant scoping');
    const client = await scopedConnect();
    try {
      return await (client.query as (...a: unknown[]) => Promise<pg.QueryResult>).apply(client, args);
    } finally {
      client.release();
    }
  };
  // Every way of reaching the database goes through bind(): callback-style connect is refused for the same reason.
  pool.connect = ((cb?: unknown) => {
    if (cb) throw new TypeError('callback-style pool.connect is not supported: it would bypass tenant scoping');
    return scopedConnect();
  }) as unknown as typeof pool.connect;
  pool.query = scopedQuery as unknown as typeof pool.query;
  return pool;
}

/**
 * Startup safety check: the connection the app serves requests with must be subject to row-level security. Refuses a superuser,
 * a role with BYPASSRLS, or one that owns the tables (an owner is exempt unless policies are FORCEd).
 */
export async function assertAppRoleIsRestricted(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owner: boolean }>(
    `SELECT r.rolsuper, r.rolbypassrls,
            EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user) AS owner
     FROM pg_roles r WHERE r.rolname = current_user`);
  const r = rows[0];
  if (!r || r.rolsuper || r.rolbypassrls || r.owner) {
    throw new Error('The database connection is not restricted by row-level security (superuser, BYPASSRLS or table owner). Set DB_APP_ROLE to the restricted role.');
  }
}
