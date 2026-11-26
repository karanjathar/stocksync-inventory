import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { withTx } from './tx.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Names of migration files that have not been applied yet (all of them if the bookkeeping table is missing). */
export async function pendingMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations').catch(() => ({ rows: [] as { name: string }[] }));
  const done = new Set(rows.map((r) => r.name));
  return files.filter((f) => !done.has(f));
}

/** Applies pending *.sql migrations in filename order. Returns the names applied. */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await withTx(pool, async (c) => {
      // Serialise concurrent migrators (e.g. two replicas starting at once).
      await c.query('SELECT pg_advisory_xact_lock(727274)');
      const exists = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (exists.rowCount) return;
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    });
  }
  return applied;
}
