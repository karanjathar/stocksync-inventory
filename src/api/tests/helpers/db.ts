import pg from 'pg';
import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/inventory_test';

/**
 * Fresh, fully migrated database for each test file. The returned pool is the RESTRICTED app role with the default tenant as fallback, so the whole
 * suite runs under row-level security exactly like production (a superuser pool would silently bypass it).
 */
export async function freshDb(): Promise<pg.Pool> {
  const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  await owner.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(owner);
  await owner.query('GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO stocksync_app'); // tests reset tables; the production role cannot
  const tenantId = (await owner.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'default'")).rows[0]!.id;
  await owner.end();
  return createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'stocksync_app', fallbackTenantId: tenantId });
}

/** Adds another business (tenant) to the test database. Tenants are platform-level, so this uses the owner connection, not the app role. */
export async function addTenant(slug: string, name = slug): Promise<string> {
  const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    return (await owner.query<{ id: string }>('INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id', [slug, name])).rows[0]!.id;
  } finally {
    await owner.end();
  }
}
