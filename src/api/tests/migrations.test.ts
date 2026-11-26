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
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
let main: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
  (await freshDb()).end(); // makes sure the shared public schema (pgcrypto, the app role) exists
  main = new pg.Pool({ connectionString: TEST_DATABASE_URL }); // the owner: schema DDL is not something the app role may do
  await main.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  // Isolated schema: simulates an existing Release 1 database without touching the shared test schema.
  // The owner bypasses RLS but still needs a tenant for the NOT NULL tenant_id default; it is set on every connection at start.
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA},public -c app.tenant_id=${DEFAULT_TENANT}` });
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
    // Release 1/2 rows: outbound messages were logged as 'ok' (T59 normalises them to 'sent').
    await pool.query("INSERT INTO channel_messages (channel, direction, external_user, text, status) VALUES ('whatsapp','out','91999','legacy','ok'), ('whatsapp','in','91999','hello','ok')");

    expect(await migrate(pool)).toEqual(['003_payments_chat.sql', '004_refunded.sql', '005_outbox_jobs.sql', '006_purchase_orders.sql', '007_gst_invoices.sql', '008_barcodes_counts.sql', '009_refunds.sql', '010_tenancy.sql', '011_rls.sql', '012_tenant_maintenance.sql', '013_platform_auth.sql', '014_tenant_jobs.sql', '015_tenant_directory.sql', '016_tenant_channels.sql', '017_tenant_foreign_keys.sql', '018_signup.sql', '019_plans.sql', '020_billing.sql', '021_audit.sql']);
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

describe('migration 005 outbox and jobs (T59)', () => {
  it('adds outbox columns, normalises legacy statuses and enforces job constraints', async () => {
    const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);
    expect(await migrate(pool)).toEqual([]); // idempotent
    const { rows: cols } = await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'channel_messages' AND table_schema = $1", [SCHEMA]);
    for (const c of ['payload', 'provider_message_id', 'attempts', 'error_code', 'error_message', 'status_at', 'event']) {
      expect(cols.map((r: { column_name: string }) => r.column_name)).toContain(c);
    }
    const { rows } = await q("SELECT direction, status FROM channel_messages WHERE external_user = '91999' ORDER BY direction");
    expect(rows).toEqual([{ direction: 'in', status: 'ok' }, { direction: 'out', status: 'sent' }]);

    await q("INSERT INTO channel_messages (channel, direction, external_user, text, provider_message_id) VALUES ('whatsapp','out','1','a','wamid.1')");
    await expect(q("INSERT INTO channel_messages (channel, direction, external_user, text, provider_message_id) VALUES ('whatsapp','out','2','b','wamid.1')")).rejects.toMatchObject({ code: '23505' });

    await q("INSERT INTO jobs (kind, dedupe_key) VALUES ('maintenance.prune', 'd1')");
    await expect(q("INSERT INTO jobs (kind, dedupe_key) VALUES ('maintenance.prune', 'd1')")).rejects.toMatchObject({ code: '23505' });
    await q("UPDATE jobs SET status = 'done' WHERE dedupe_key = 'd1'");
    await q("INSERT INTO jobs (kind, dedupe_key) VALUES ('maintenance.prune', 'd1')"); // finished jobs free the key
    await expect(q("INSERT INTO jobs (kind, status) VALUES ('x', 'bogus')")).rejects.toMatchObject({ code: '23514' });
    await q("INSERT INTO worker_heartbeats (worker_id) VALUES ('w1')");
    await q("INSERT INTO maintenance_runs (task, ran_at, result) VALUES ('prune', now(), '{}')");
  });
});

describe('migration 006 purchase orders (T69)', () => {
  it('stores POs with lines and rejects invalid states', async () => {
    const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);
    const sup = (await q("INSERT INTO suppliers (name) VALUES ('Acme') RETURNING id")).rows[0].id as string;
    const wh = (await q("INSERT INTO warehouses (code, name) VALUES ('M6', 'Main') RETURNING id")).rows[0].id as string;
    const p1 = (await q("INSERT INTO products (sku, name, price_cents) VALUES ('PO-1', 'One', 100) RETURNING id")).rows[0].id as string;
    const po = (await q('INSERT INTO purchase_orders (supplier_id, warehouse_id) VALUES ($1, $2) RETURNING id, number, status', [sup, wh])).rows[0];
    expect(po.status).toBe('DRAFT');
    expect(po.number).toBeGreaterThan(0);

    const line = (qty: number, received = 0, cost = 50, product = p1) =>
      q('INSERT INTO purchase_order_lines (po_id, product_id, quantity, received_quantity, unit_cost_cents) VALUES ($1, $2, $3, $4, $5)', [po.id, product, qty, received, cost]);
    await expect(line(0)).rejects.toMatchObject({ code: '23514' });          // quantity > 0
    await expect(line(5, 6)).rejects.toMatchObject({ code: '23514' });       // received <= ordered
    await expect(line(5, 0, -1)).rejects.toMatchObject({ code: '23514' });   // cost >= 0
    await line(5);
    await expect(line(7)).rejects.toMatchObject({ code: '23505' });          // one line per product
    await expect(q("UPDATE purchase_orders SET status = 'LOST' WHERE id = $1", [po.id])).rejects.toMatchObject({ code: '23514' });

    await q("INSERT INTO purchase_receipts (po_id, receipt_id) VALUES ($1, 'r1')", [po.id]);
    await expect(q("INSERT INTO purchase_receipts (po_id, receipt_id) VALUES ($1, 'r1')", [po.id])).rejects.toMatchObject({ code: '23505' });
    await q("INSERT INTO purchase_receipts (po_id, receipt_id) VALUES ($1, 'r2')", [po.id]);
    // deleting a PO removes its lines and receipts
    await q('DELETE FROM purchase_orders WHERE id = $1', [po.id]);
    expect((await q('SELECT 1 FROM purchase_order_lines WHERE po_id = $1', [po.id])).rowCount).toBe(0);
  });
});

describe('migration 007 GST invoices (T73)', () => {
  it('keeps existing products and customers, and guards invoices', async () => {
    const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);
    const prod = (await q("SELECT hsn_code, gst_rate_bp FROM products WHERE sku = 'PO-1'")).rows[0];
    expect(prod).toEqual({ hsn_code: null, gst_rate_bp: 0 });
    await expect(q("UPDATE products SET gst_rate_bp = 2900 WHERE sku = 'PO-1'")).rejects.toMatchObject({ code: '23514' });
    await q("UPDATE products SET gst_rate_bp = 1800, hsn_code = '6109' WHERE sku = 'PO-1'");
    const cust = (await q("INSERT INTO customers (name, gstin, state_code) VALUES ('B2B', '27AAPFU0939F1ZV', '27') RETURNING id")).rows[0].id as string;
    const order = (await q("INSERT INTO orders (customer_id, channel, status, total_cents) VALUES ($1, 'manual', 'CONFIRMED', 1000) RETURNING id", [cust])).rows[0].id as string;
    const inv = (n: number, number: string, orderId: string, fy = '2026-27', status = 'ISSUED') => q(
      `INSERT INTO invoices (order_id, fy, seq, number, status, snapshot, taxable_cents, tax_cents, total_cents) VALUES ($1, $2, $3, $4, $5, '{}', 847, 153, 1000)`, [orderId, fy, n, number, status]);
    await inv(1, 'INV/2026-27/000001', order);
    await expect(inv(2, 'INV/2026-27/000002', order)).rejects.toMatchObject({ code: '23505' });           // one invoice per order
    const order2 = (await q("INSERT INTO orders (customer_id, channel, status, total_cents) VALUES ($1, 'manual', 'CONFIRMED', 500) RETURNING id", [cust])).rows[0].id as string;
    await expect(inv(1, 'INV/2026-27/000009', order2)).rejects.toMatchObject({ code: '23505' });           // (fy, seq) unique: no duplicate sequence
    await expect(inv(3, 'INV/2026-27/000001', order2)).rejects.toMatchObject({ code: '23505' });           // number unique
    await expect(inv(3, 'INV/2026-27/000003', order2, '2026-27', 'LOST')).rejects.toMatchObject({ code: '23514' });
    await q("INSERT INTO invoice_counters (fy, last_number) VALUES ('2026-27', 1)");
    await expect(q("INSERT INTO invoice_counters (fy, last_number) VALUES ('2026-27', 2)")).rejects.toMatchObject({ code: '23505' });
  });
});

describe('migration 008 barcodes and counts (T79)', () => {
  it('enforces unique barcodes (many NULLs allowed) and valid count sessions', async () => {
    const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);
    await q("INSERT INTO products (sku, name, price_cents, barcode) VALUES ('B1', 'B1', 1, 'CODE-0001'), ('B2', 'B2', 1, NULL), ('B3', 'B3', 1, NULL)");
    await expect(q("INSERT INTO products (sku, name, price_cents, barcode) VALUES ('B4', 'B4', 1, 'CODE-0001')")).rejects.toMatchObject({ code: '23505' });
    const wh = (await q("INSERT INTO warehouses (code, name) VALUES ('CNT', 'Counts') RETURNING id")).rows[0].id as string;
    const prod = (await q("SELECT id FROM products WHERE sku = 'B1'")).rows[0].id as string;
    const count = (await q('INSERT INTO stock_counts (warehouse_id) VALUES ($1) RETURNING id, number, status', [wh])).rows[0];
    expect(count.status).toBe('OPEN');
    await expect(q("UPDATE stock_counts SET status = 'DONE' WHERE id = $1", [count.id])).rejects.toMatchObject({ code: '23514' });
    await q('INSERT INTO stock_count_lines (count_id, product_id, counted_quantity) VALUES ($1, $2, 5)', [count.id, prod]);
    await expect(q('INSERT INTO stock_count_lines (count_id, product_id, counted_quantity) VALUES ($1, $2, 6)', [count.id, prod])).rejects.toMatchObject({ code: '23505' });
    await expect(q('UPDATE stock_count_lines SET counted_quantity = -1 WHERE count_id = $1', [count.id])).rejects.toMatchObject({ code: '23514' });
    await q('DELETE FROM stock_counts WHERE id = $1', [count.id]);
    expect((await q('SELECT 1 FROM stock_count_lines WHERE count_id = $1', [count.id])).rowCount).toBe(0);
  });
});

describe('migration 010 tenancy (T88)', () => {
  const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);
  const TABLES = ['users', 'categories', 'products', 'warehouses', 'stock_levels', 'stock_movements', 'suppliers', 'customers', 'orders', 'order_items', 'settings',
    'channel_messages', 'payments', 'webhook_events', 'chat_carts', 'purchase_orders', 'purchase_order_lines', 'purchase_receipts', 'invoice_counters', 'invoices', 'stock_counts', 'stock_count_lines'];

  it('creates a default tenant and moves every existing row into it, keeping numbers', async () => {
    const tenants = (await q('SELECT id, slug, status, plan FROM tenants')).rows;
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({ slug: 'default', status: 'ACTIVE', plan: 'BUSINESS' });
    for (const t of TABLES) {
      const col = (await q("SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'tenant_id'", [SCHEMA, t])).rows[0];
      expect(col, t).toEqual({ is_nullable: 'NO' });
      expect((await q(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id <> $1`, [tenants[0].id])).rows[0].n, t).toBe(0);
    }
    // The orders created in the Release 1 test above keep their numbers, and new ones continue after them.
    const numbers = (await q('SELECT number FROM orders ORDER BY number')).rows.map((r) => r.number);
    const cust = (await q("SELECT id FROM customers LIMIT 1")).rows[0].id as string;
    const fresh = (await q("INSERT INTO orders (customer_id, channel, status, total_cents) VALUES ($1, 'manual', 'PENDING', 1) RETURNING number", [cust])).rows[0].number as number;
    expect(fresh).toBe(Math.max(...numbers) + 1);
  });

  it('lets two tenants use the same SKU, barcode, warehouse code, category and customer identity', async () => {
    const t2 = (await q("INSERT INTO tenants (slug, name) VALUES ('second', 'Second Shop') RETURNING id")).rows[0].id as string;
    const withTenant = (sql: string, args: unknown[] = []) => q(sql.replace('INSERT INTO ', 'INSERT INTO ').replace(/\(/, '(tenant_id, ').replace('VALUES (', `VALUES ('${t2}', `), args);
    await q("INSERT INTO products (sku, name, price_cents, barcode) VALUES ('TWIN', 'One', 1, 'TWIN-CODE-1')");
    await withTenant("INSERT INTO products (sku, name, price_cents, barcode) VALUES ('TWIN', 'Two', 1, 'TWIN-CODE-1')");
    await expect(q("INSERT INTO products (sku, name, price_cents) VALUES ('TWIN', 'Dup', 1)")).rejects.toMatchObject({ code: '23505' });
    await q("INSERT INTO warehouses (code, name) VALUES ('TWINW', 'a')");
    await withTenant("INSERT INTO warehouses (code, name) VALUES ('TWINW', 'b')");
    await expect(q("INSERT INTO warehouses (code, name) VALUES ('TWINW', 'c')")).rejects.toMatchObject({ code: '23505' });
    await q("INSERT INTO categories (name) VALUES ('Twin Cat')");
    await withTenant("INSERT INTO categories (name) VALUES ('Twin Cat')");
    await q("INSERT INTO customers (name, channel, channel_user_id) VALUES ('c', 'whatsapp', '9100')");
    await withTenant("INSERT INTO customers (name, channel, channel_user_id) VALUES ('c', 'whatsapp', '9100')");
    await expect(q("INSERT INTO customers (name, channel, channel_user_id) VALUES ('c', 'whatsapp', '9100')")).rejects.toMatchObject({ code: '23505' });
    await q("INSERT INTO settings (key, value) VALUES ('twin', '1')");
    await withTenant("INSERT INTO settings (key, value) VALUES ('twin', '2')");
    await expect(q("INSERT INTO settings (key, value) VALUES ('twin', '3')")).rejects.toMatchObject({ code: '23505' });
    await q("INSERT INTO invoice_counters (fy, last_number) VALUES ('2030-31', 1)");
    await withTenant("INSERT INTO invoice_counters (fy, last_number) VALUES ('2030-31', 1)");
  });

  it('numbers orders, purchase orders and counts per tenant', async () => {
    const t2 = (await q("SELECT id FROM tenants WHERE slug = 'second'")).rows[0].id as string;
    const c1 = (await q("SELECT id FROM customers WHERE channel_user_id = '9100' AND tenant_id <> $1", [t2])).rows[0].id as string;
    const c2 = (await q("SELECT id FROM customers WHERE channel_user_id = '9100' AND tenant_id = $1", [t2])).rows[0].id as string;
    const ins = (cust: string, tenant: string) => q("INSERT INTO orders (tenant_id, customer_id, channel, status, total_cents) VALUES ($1, $2, 'manual', 'PENDING', 1) RETURNING number", [tenant, cust]);
    const first = (await ins(c2, t2)).rows[0].number as number;
    const second = (await ins(c2, t2)).rows[0].number as number;
    expect([first, second]).toEqual([1, 2]);                         // the second tenant starts at 1
    const def = (await q('SELECT id FROM tenants WHERE slug = $1', ['default'])).rows[0].id as string;
    expect((await ins(c1, def)).rows[0].number).toBeGreaterThan(2);  // the first tenant keeps counting from its own history
    await expect(q("INSERT INTO orders (tenant_id, customer_id, channel, status, total_cents, number) VALUES ($1, $2, 'manual', 'PENDING', 1, 1)", [t2, c2])).rejects.toMatchObject({ code: '23505' });
    const wh = (await q("SELECT id FROM warehouses WHERE tenant_id = $1 LIMIT 1", [t2])).rows[0].id as string;
    expect((await q('INSERT INTO stock_counts (tenant_id, warehouse_id) VALUES ($1, $2) RETURNING number', [t2, wh])).rows[0].number).toBe(1);
  });

  it('keeps unique tenant slugs and valid statuses', async () => {
    await expect(q("INSERT INTO tenants (slug, name) VALUES ('second', 'dup')")).rejects.toMatchObject({ code: '23505' });
    await expect(q("INSERT INTO tenants (slug, name) VALUES ('Bad Slug!', 'x')")).rejects.toMatchObject({ code: '23514' });
    await expect(q("UPDATE tenants SET status = 'GONE' WHERE slug = 'second'")).rejects.toMatchObject({ code: '23514' });
  });
});

