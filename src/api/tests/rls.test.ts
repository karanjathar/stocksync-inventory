import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './helpers/db.js';
import { assertAppRoleIsRestricted, createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { withTx } from '../src/db/tx.js';
import { runWithTenant } from '../src/db/tenant.js';

/** Row-level security (D-018/D-019): isolation must hold for raw SQL with no WHERE, under the restricted app role. */
let owner: pg.Pool; let app: pg.Pool; let A: string; let B: string;
const as = <T>(tenant: string, fn: () => Promise<T>) => runWithTenant(tenant, fn);

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  await owner.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(owner);
  A = (await owner.query("INSERT INTO tenants (slug, name) VALUES ('tenant-a', 'Shop A') RETURNING id")).rows[0].id;
  B = (await owner.query("INSERT INTO tenants (slug, name) VALUES ('tenant-b', 'Shop B') RETURNING id")).rows[0].id;
  app = createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'stocksync_app' }); // strict: no fallback tenant
  for (const [t, n] of [[A, 2], [B, 3]] as const) {
    await as(t, async () => {
      for (let i = 1; i <= n; i++) await app.query('INSERT INTO products (sku, name, price_cents) VALUES ($1, $2, 100)', [`SKU${i}`, `Product ${i}`]);
      await app.query("INSERT INTO warehouses (code, name) VALUES ('MAIN', 'Main')");
      await app.query("INSERT INTO customers (name, channel, channel_user_id) VALUES ('Cust', 'whatsapp', '9100')");
    });
  }
});
afterAll(async () => { await app.end(); await owner.end(); });

describe('the app role', () => {
  it('is not a superuser, has no BYPASSRLS, and owns nothing', async () => {
    const r = (await as(A, () => app.query("SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"))).rows[0];
    expect(r).toEqual({ u: 'stocksync_app', rolsuper: false, rolbypassrls: false });
    await expect(assertAppRoleIsRestricted(app)).resolves.toBeUndefined();
  });

  it('startup refuses a connection that would bypass row-level security', async () => {
    await expect(assertAppRoleIsRestricted(owner)).rejects.toThrow(/row-level security/i);
  });

  it('fails closed when the role does not exist instead of silently running as the owner', async () => {
    const bad = createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'no_such_role_xyz' });
    await expect(as(A, () => bad.query('SELECT 1'))).rejects.toThrow();
    await bad.end();
  });
});

describe('isolation for raw SQL with no WHERE', () => {
  it('SELECT returns only the current tenant\'s rows', async () => {
    expect((await as(A, () => app.query('SELECT sku FROM products'))).rows).toHaveLength(2);
    expect((await as(B, () => app.query('SELECT sku FROM products'))).rows).toHaveLength(3);
    expect((await as(B, () => app.query('SELECT count(*)::int AS n FROM customers'))).rows[0].n).toBe(1);
  });

  it('UPDATE and DELETE without a WHERE touch only the current tenant', async () => {
    const upd = await as(B, () => app.query("UPDATE products SET name = 'hacked'"));
    expect(upd.rowCount).toBe(3);
    expect((await as(A, () => app.query("SELECT count(*)::int AS n FROM products WHERE name = 'hacked'"))).rows[0].n).toBe(0);
    await as(B, () => app.query("UPDATE products SET name = 'Product ' || sku"));
    const del = await as(B, () => app.query("DELETE FROM warehouses"));
    expect(del.rowCount).toBe(1);
    expect((await as(A, () => app.query('SELECT 1 FROM warehouses'))).rowCount).toBe(1);
    await as(B, () => app.query("INSERT INTO warehouses (code, name) VALUES ('MAIN', 'Main')"));
  });

  it('cannot write a row for, or move a row to, another tenant', async () => {
    await expect(as(B, () => app.query("INSERT INTO products (tenant_id, sku, name, price_cents) VALUES ($1, 'EVIL', 'x', 1)", [A]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(B, () => app.query('UPDATE products SET tenant_id = $1', [A]))).rejects.toMatchObject({ code: '42501' });
    expect((await owner.query("SELECT count(*)::int AS n FROM products WHERE sku = 'EVIL'")).rows[0].n).toBe(0);
  });

  it('a tenant sees only its own tenant row and its own counters', async () => {
    expect((await as(A, () => app.query('SELECT slug FROM tenants'))).rows).toEqual([{ slug: 'tenant-a' }]);
    await as(A, () => app.query("INSERT INTO suppliers (name) VALUES ('s')"));
    const cust = (await as(A, () => app.query('SELECT id FROM customers'))).rows[0].id;
    await as(A, () => app.query("INSERT INTO orders (customer_id, channel, status, total_cents) VALUES ($1, 'manual', 'PENDING', 1)", [cust]));
    expect((await as(A, () => app.query('SELECT kind, last_number FROM tenant_counters'))).rows).toEqual([{ kind: 'order', last_number: 1 }]);
    expect((await as(B, () => app.query('SELECT * FROM tenant_counters'))).rows).toHaveLength(0);
  });

  it('numbers start at 1 for every tenant, under the restricted role', async () => {
    const custB = (await as(B, () => app.query('SELECT id FROM customers'))).rows[0].id;
    const n = (await as(B, () => app.query("INSERT INTO orders (customer_id, channel, status, total_cents) VALUES ($1, 'manual', 'PENDING', 1) RETURNING number", [custB]))).rows[0].number;
    expect(n).toBe(1);
  });
});

describe('no context, no data', () => {
  it('a query outside any tenant context sees nothing and cannot insert', async () => {
    expect((await app.query('SELECT * FROM products')).rows).toHaveLength(0);
    const err = await app.query("INSERT INTO products (sku, name, price_cents) VALUES ('NOCTX', 'x', 1)").catch((e: unknown) => e) as { code?: string };
    expect(['23502', '42501']).toContain(err.code); // refused either by the NOT NULL tenant_id or by the policy
  });

  it('a tenant left over from an earlier request never leaks to the next one on the same connection', async () => {
    const one = createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'stocksync_app', max: 1 });
    expect((await as(A, () => one.query('SELECT sku FROM products'))).rows).toHaveLength(2);
    expect((await as(B, () => one.query('SELECT sku FROM products'))).rows).toHaveLength(3);
    expect((await one.query('SELECT sku FROM products')).rows).toHaveLength(0);
    await one.end();
  });

  it('a configured fallback tenant applies only where no context was set', async () => {
    const withFallback = createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'stocksync_app', fallbackTenantId: A });
    expect((await withFallback.query('SELECT sku FROM products')).rows).toHaveLength(2);
    expect((await as(B, () => withFallback.query('SELECT sku FROM products'))).rows).toHaveLength(3);
    await withFallback.end();
  });
});

describe('concurrency and transactions', () => {
  it('50 interleaved requests from two tenants each see only their own rows', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => {
      const t = i % 2 ? A : B;
      return as(t, async () => ({ t, n: (await app.query('SELECT count(*)::int AS n FROM products')).rows[0].n as number }));
    }));
    for (const r of results) expect(r.n).toBe(r.t === A ? 2 : 3);
  });

  it('transactions run in the tenant context and roll back with it', async () => {
    await as(A, async () => {
      await expect(withTx(app, async (c) => {
        await c.query("INSERT INTO products (sku, name, price_cents) VALUES ('TX1', 'tx', 1)");
        expect((await c.query('SELECT count(*)::int AS n FROM products')).rows[0].n).toBe(3);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect((await app.query('SELECT count(*)::int AS n FROM products')).rows[0].n).toBe(2);
    });
  });
});

describe('guard: every table is either tenant-scoped with RLS or explicitly platform-level', () => {
  const PLATFORM_TABLES = ['schema_migrations', 'jobs', 'worker_heartbeats', 'tenants', 'platform_admins'];
  // The job queue is shared by the workers, which claim work across businesses, so it is NOT row-level secured: it holds ids and kinds only,
  // jobs run inside their own tenant, and the tenant-facing views filter on current_tenant(). The platform queue view is the only cross-tenant read.
  const QUEUE_TABLES = ['jobs'];
  it('every table with a tenant_id column has row-level security and a policy', async () => {
    const { rows } = await owner.query(`
      SELECT c.relname, c.relrowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows.filter((x) => !QUEUE_TABLES.includes(x.relname))) expect(r, r.relname).toMatchObject({ relrowsecurity: true, policies: 1 });
  });

  it('no other table exists unless it is on the platform list (a new table must choose)', async () => {
    const { rows } = await owner.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    expect(rows.map((r) => r.relname).filter((t) => !PLATFORM_TABLES.includes(t)).sort()).toEqual([]);
    expect((await owner.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'tenants'")).rows[0].relrowsecurity).toBe(true);
  });

  it('the app role cannot change migration history', async () => {
    await expect(as(A, () => app.query("DELETE FROM schema_migrations"))).rejects.toMatchObject({ code: '42501' });
  });
});
