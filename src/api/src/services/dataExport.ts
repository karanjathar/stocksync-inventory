import type { Response } from 'express';
import { once } from 'node:events';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import type pg from 'pg';

/** Internal bookkeeping or secrets: never part of an export. Everything else with a tenant_id is exported automatically. */
const SKIP_TABLES = new Set(['tenant_channels', 'jobs', 'webhook_events', 'subscriptions', 'deletion_requests', 'tenant_counters']);
const SKIP_COLUMNS: Record<string, string[]> = { users: ['password_hash'] };
const BATCH = 500;

/** One CSV cell. Text that a spreadsheet would run as a formula is neutralised (CSV injection). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Streams the whole data of the current business as a zip of CSV files (one per table) plus settings.json, manifest.json and README.txt.
 * Memory stays bounded: rows are read through a server-side cursor in batches of 500 and compressed as they arrive; the response honours back-pressure.
 * A single REPEATABLE READ snapshot keeps the files consistent with each other. Passwords, channel credentials and queue internals are excluded.
 */
export async function streamExport(pool: pg.Pool, res: Response, filename: string, tenant: { slug: string; name: string }): Promise<void> {
  const client = await pool.connect(); // bound to the current business by the pool wrapper
  let open = true;
  res.on('close', () => { open = false; });
  res.set({ 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  let backpressure = false;
  const zip = new Zip((err, chunk, final) => {
    if (err || !open) return;
    if (!res.write(chunk)) backpressure = true;
    if (final) res.end();
  });
  const settle = async () => { if (backpressure && open) { backpressure = false; await once(res, 'drain'); } };
  const addFile = async (name: string, parts: AsyncIterable<string> | Iterable<string>) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    for await (const part of parts) { if (!open) break; f.push(strToU8(part), false); await settle(); }
    f.push(new Uint8Array(0), true);
    await settle();
  };
  const counts: Record<string, number> = {};
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await client.query<{ t: string }>(
      `SELECT DISTINCT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`)).rows.map((r) => r.t).filter((t) => !SKIP_TABLES.has(t));
    let i = 0;
    for (const table of tables) {
      const cursor = `export_${i++}`;
      await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT * FROM "${table}"`); // table names come from the catalogue, never from the request
      const skip = new Set(SKIP_COLUMNS[table] ?? []);
      counts[table] = 0;
      async function* rows(): AsyncGenerator<string> {
        let header = false;
        for (;;) {
          const batch = await client.query(`FETCH ${BATCH} FROM ${cursor}`);
          const cols = batch.fields.map((f) => f.name).filter((n) => n !== 'tenant_id' && !skip.has(n));
          if (!header) { yield `${cols.join(',')}\n`; header = true; }
          if (!batch.rows.length) return;
          counts[table] = (counts[table] ?? 0) + batch.rows.length;
          yield batch.rows.map((r: Record<string, unknown>) => cols.map((c) => csvCell(r[c])).join(',')).join('\n') + '\n';
        }
      }
      await addFile(`${table}.csv`, rows());
      await client.query(`CLOSE ${cursor}`);
    }
    await client.query('COMMIT');
    await addFile('manifest.json', [JSON.stringify({ business: tenant, exportedAt: new Date().toISOString(), format: 'one CSV file per table, UTF-8', rows: counts }, null, 2)]);
    await addFile('README.txt', ['StockSync data export\n\nEvery table of your business as CSV. Money is in the smallest currency unit (paise/cents). ',
      'Passwords, channel access tokens and internal job queues are not included. Text beginning with = + - @ is prefixed with an apostrophe so spreadsheets do not run it as a formula.\n']);
    zip.end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    zip.terminate();
    if (!res.headersSent) throw err;
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  } finally {
    client.release();
  }
}
