import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, TEST_DATABASE_URL } from './helpers/db.js';
import { migrate } from '../src/db/migrate.js';
import { withTx } from '../src/db/tx.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(async () => { await pool.end(); });

describe('migrations', () => {
  it('creates all schema tables', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['users', 'categories', 'products', 'warehouses', 'stock_levels', 'stock_movements',
      'suppliers', 'customers', 'orders', 'order_items', 'settings', 'channel_messages', 'schema_migrations']) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent', async () => {
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL }); // the app role may not touch migration history
    try { expect(await migrate(owner)).toEqual([]); } finally { await owner.end(); }
  });
});

describe('withTx', () => {
  it('rolls back on error', async () => {
    await expect(
      withTx(pool, async (c) => {
        await c.query("INSERT INTO categories (name) VALUES ('rollback-me')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rowCount } = await pool.query("SELECT 1 FROM categories WHERE name='rollback-me'");
    expect(rowCount).toBe(0);
  });

  it('commits on success and returns the value', async () => {
    const v = await withTx(pool, async (c) => {
      await c.query("INSERT INTO categories (name) VALUES ('kept')");
      return 42;
    });
    expect(v).toBe(42);
    const { rowCount } = await pool.query("SELECT 1 FROM categories WHERE name='kept'");
    expect(rowCount).toBe(1);
  });
});
