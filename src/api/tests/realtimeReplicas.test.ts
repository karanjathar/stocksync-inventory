import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { EventBus } from '../src/realtime/bus.js';
import { PgBus, INLINE_LIMIT_BYTES } from '../src/realtime/pgBus.js';
import { runWithTenant } from '../src/db/tenant.js';
import type { RealtimeEvent } from '../src/domain/types.js';

/** Two API replicas = two EventBus + PgBus pairs on one database. */
let pool: pg.Pool; let A: string; let B: string;
let busOne: EventBus; let busTwo: EventBus; let pgOne: PgBus; let pgTwo: PgBus;
const logger = pino({ level: 'silent' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const orderEvent = (n: number): RealtimeEvent => ({ type: 'order.created', number: n } as RealtimeEvent);
const collect = (bus: EventBus, tenant: string) => { const got: RealtimeEvent[] = []; bus.subscribe((e) => got.push(e), tenant); return got; };

beforeAll(async () => {
  pool = await freshDb();
  A = await addTenant('rt-a'); B = await addTenant('rt-b');
  busOne = new EventBus(); busTwo = new EventBus();
  pgOne = new PgBus({ connectionString: TEST_DATABASE_URL, ssl: false, pool, logger }, busOne);
  pgTwo = new PgBus({ connectionString: TEST_DATABASE_URL, ssl: false, pool, logger }, busTwo);
  await pgOne.start(); await pgTwo.start();
});
afterAll(async () => { await pgOne.stop(); await pgTwo.stop(); await pool.end(); });

describe('events across replicas', () => {
  it('reach clients of the same business on the other replica, once, and never another business', async () => {
    const aOnTwo = collect(busTwo, A); const bOnTwo = collect(busTwo, B); const aOnOne = collect(busOne, A);
    runWithTenant(A, async () => { busOne.publish(orderEvent(1)); });
    await wait(300);
    expect(aOnTwo).toEqual([orderEvent(1)]);   // the other replica's client of the same business
    expect(bOnTwo).toEqual([]);                // another business never
    expect(aOnOne).toEqual([orderEvent(1)]);   // the publishing replica delivers locally exactly once (its own notification is ignored)
  });

  it('works in both directions and keeps each business separate', async () => {
    const bOnOne = collect(busOne, B); const aOnOne = collect(busOne, A);
    runWithTenant(B, async () => { busTwo.publish(orderEvent(2)); });
    await wait(300);
    expect(bOnOne).toEqual([orderEvent(2)]);
    expect(aOnOne).toEqual([]);
  });

  it('carries events too big for a NOTIFY as a reference and still delivers them whole', async () => {
    const big = { type: 'message.received', channel: 'whatsapp', from: '1', text: 'x'.repeat(INLINE_LIMIT_BYTES + 2000) } as unknown as RealtimeEvent;
    const got = collect(busTwo, A);
    runWithTenant(A, async () => { busOne.publish(big); });
    await wait(400);
    expect(got).toEqual([big]);
    expect((await runWithTenant(A, () => pool.query('SELECT count(*)::int AS n FROM realtime_payloads'))).rows[0].n).toBe(1);
    expect((await runWithTenant(B, () => pool.query('SELECT count(*)::int AS n FROM realtime_payloads'))).rows[0].n).toBe(0); // reference rows are private to their business
  });

  it('ignores a forged notification: a made-up business, a reference into another business, garbage', async () => {
    const aOnTwo = collect(busTwo, A); const bOnTwo = collect(busTwo, B);
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    try {
      const secret = (await owner.query<{ id: string }>("INSERT INTO realtime_payloads (tenant_id, payload) VALUES ($1, $2) RETURNING id", [A, JSON.stringify(orderEvent(99))])).rows[0]!.id;
      const send = (wire: unknown) => owner.query("SELECT pg_notify('stocksync_events', $1)", [typeof wire === 'string' ? wire : JSON.stringify(wire)]);
      await send({ o: 'forged', t: B, ref: secret });                                  // B's name on A's reference row
      await send({ o: 'forged', t: 'not-a-uuid', e: orderEvent(98) });
      await send({ o: 'forged', t: '00000000-0000-4000-8000-0000000000aa', e: orderEvent(97) }); // unknown business: reaches nobody
      await send('{not json');
      await wait(300);
    } finally { await owner.end(); }
    expect(bOnTwo).toEqual([]);   // RLS: the reference is only readable as A, so naming B finds nothing
    expect(aOnTwo).toEqual([]);
  });

  it('recovers when the listener connection is dropped', async () => {
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    try {
      await owner.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN stocksync_events%' AND pid <> pg_backend_pid()");
    } finally { await owner.end(); }
    await wait(1800); // first retry after 500 ms
    const got = collect(busTwo, A);
    runWithTenant(A, async () => { busOne.publish(orderEvent(5)); });
    await wait(400);
    expect(got).toEqual([orderEvent(5)]);
  });
});
