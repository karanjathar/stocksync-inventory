import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { freshDb, TEST_DATABASE_URL } from './helpers/db.js';
import { migrate } from '../src/db/migrate.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const SCHEMA = 'upgrade_t29';
let main: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
  main = await freshDb();
  await main.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  // Isolated schema: simulates an existing Release 1 database without touching the shared test schema.
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA},public` });
});
afterAll(async () => {
  await pool.end();
  await main.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await main.end();
});

describe('migrations 003–004 on an existing Release 1 database (T29, T58)', () => {
  it('upgrades in place, keeps data, adds defaults and constraints', async () => {
    const v1 = mkdtempSync(path.join(tmpdir(), 'mig-'));
    for (const f of ['001_init.sql', '002_reply_options.sql']) copyFileSync(path.join(MIGRATIONS, f), path.join(v1, f));
    await migrate(pool, v1);
    const cust = await pool.query<{ id: string }>("INSERT INTO customers (name) VALUES ('Legacy') RETURNING id");
    await pool.query("INSERT INTO orders (customer_id, channel, status, total_cents) VALUES ($1, 'manual', 'PENDING', 500), ($1, 'web', 'FULFILLED', 900)", [cust.rows[0]!.id]);

    expect(await migrate(pool)).toEqual(['003_payments_chat.sql', '004_refunded.sql']);
    expect(await migrate(pool)).toEqual([]);

    const { rows } = await pool.query<{ payment_method: string; payment_status: string; public_token: string }>('SELECT payment_method, payment_status, public_token FROM orders ORDER BY number');
    expect(rows.map((r) => [r.payment_method, r.payment_status])).toEqual([['COD', 'UNPAID'], ['COD', 'UNPAID']]);
    expect(new Set(rows.map((r) => r.public_token)).size).toBe(2);
    expect(rows[0]!.public_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows only one open payment per order and rejects bad values', async () => {
    const { rows: [o] } = await pool.query<{ id: string }>('SELECT id FROM orders ORDER BY number LIMIT 1');
    const pay = (ref: string, status = 'CREATED') => pool.query(
      `INSERT INTO payments (order_id, provider_ref, reference_id, status, amount_cents, currency, short_url, expires_at)
       VALUES ($1, $2, $2, $3, 500, 'INR', 'https://rzp.io/i/x', now() + interval '1 day')`, [o!.id, ref, status]);
    await pay('plink_1');
    await expect(pay('plink_2')).rejects.toMatchObject({ code: '23505' });
    await pool.query("UPDATE payments SET status = 'EXPIRED' WHERE provider_ref = 'plink_1'");
    await pay('plink_2');
    await expect(pay('plink_3', 'BOGUS')).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE orders SET payment_status = 'MAYBE' WHERE id = $1", [o!.id])).rejects.toMatchObject({ code: '23514' });
    await pool.query("UPDATE orders SET payment_status = 'REFUNDED' WHERE id = $1", [o!.id]); // allowed since migration 004
    await pool.query("UPDATE orders SET payment_status = 'UNPAID' WHERE id = $1", [o!.id]);
    await expect(pool.query("INSERT INTO webhook_events (provider, event_id) VALUES ('razorpay', 'evt_1'), ('razorpay', 'evt_1')")).rejects.toMatchObject({ code: '23505' });
  });
});
