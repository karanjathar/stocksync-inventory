import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/client';
import { OfflineQueue, type QueuedCount } from './offlineQueue';

let n = 0;
const fresh = () => new OfflineQueue(`test-db-${++n}`);
const line = (productId: string, countedQuantity: number) => ({ productId, countedQuantity });

describe('OfflineQueue', () => {
  it('keeps one entry per count, merging lines (the latest quantity for a product wins), oldest count first', async () => {
    const q = fresh();
    await q.add('c1', [line('a', 1), line('b', 2)]);
    await q.add('c2', [line('x', 5)]);
    await q.add('c1', [line('b', 9), line('c', 3)]);
    const pending = await q.pending();
    expect(pending.map((p) => p.countId)).toEqual(['c1', 'c2']);
    expect(pending[0]!.lines).toEqual([line('a', 1), line('b', 9), line('c', 3)]);
    expect(await q.size()).toBe(2);
  });

  it('survives a reload: a new queue on the same database sees what was stored', async () => {
    const name = `persist-${++n}`;
    await new OfflineQueue(name).add('c1', [line('a', 4)]);
    expect((await new OfflineQueue(name).pending())[0]).toMatchObject({ countId: 'c1', lines: [line('a', 4)] });
  });

  it('sends everything in order and empties the queue', async () => {
    const q = fresh();
    await q.add('c1', [line('a', 1)]); await q.add('c2', [line('b', 2)]);
    const send = vi.fn(async (_item: QueuedCount) => {});
    const res = await q.flush(send);
    expect(send.mock.calls.map((c) => c[0].countId)).toEqual(['c1', 'c2']);
    expect(res).toEqual({ sent: ['c1', 'c2'], conflicts: [], stopped: false });
    expect(await q.size()).toBe(0);
  });

  it('stops at the first network failure and keeps that item and everything after it', async () => {
    const q = fresh();
    await q.add('c1', [line('a', 1)]); await q.add('c2', [line('b', 2)]); await q.add('c3', [line('c', 3)]);
    const send = vi.fn(async (item: { countId: string }) => { if (item.countId === 'c2') throw new TypeError('Failed to fetch'); });
    const res = await q.flush(send);
    expect(res).toMatchObject({ sent: ['c1'], stopped: true });
    expect((await q.pending()).map((p) => p.countId)).toEqual(['c2', 'c3']);
    expect(send).toHaveBeenCalledTimes(2); // c3 was not attempted
  });

  it('treats a server error as "try again later", not as lost data', async () => {
    const q = fresh();
    await q.add('c1', [line('a', 1)]);
    const res = await q.flush(async () => { throw new ApiError(503, 'UNAVAILABLE', 'down'); });
    expect(res.stopped).toBe(true);
    expect(await q.size()).toBe(1);
  });

  it('reports a count that was submitted or cancelled meanwhile as a conflict, drops it, and carries on', async () => {
    const q = fresh();
    await q.add('c1', [line('a', 1)]); await q.add('c2', [line('b', 2)]);
    const send = vi.fn(async (item: { countId: string }) => { if (item.countId === 'c1') throw new ApiError(409, 'CONFLICT', 'This count is already submitted'); });
    const res = await q.flush(send);
    expect(res.sent).toEqual(['c2']);
    expect(res.conflicts).toEqual([{ countId: 'c1', message: 'This count is already submitted' }]);
    expect(res.stopped).toBe(false);
    expect(await q.size()).toBe(0);
  });

  it('drops an entry the server rejects as invalid, and a count that no longer exists, reporting both', async () => {
    const q = fresh();
    await q.add('c1', [line('a', 1)]); await q.add('c2', [line('b', 2)]);
    const res = await q.flush(async (item) => { throw item.countId === 'c1' ? new ApiError(400, 'VALIDATION_ERROR', 'bad quantity') : new ApiError(404, 'NOT_FOUND', 'Stock count not found'); });
    expect(res.conflicts.map((c) => c.countId)).toEqual(['c1', 'c2']);
    expect(await q.size()).toBe(0);
  });

  it('two overlapping flushes never send the same item twice', async () => {
    const q = fresh();
    await q.add('c1', [line('a', 1)]);
    const send = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await Promise.all([q.flush(send), q.flush(send)]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps a line added while a flush is in flight for the next flush', async () => {
    const q = fresh();
    await q.add('c1', [line('a', 1)]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = q.flush(async () => { await gate; });
    await new Promise((r) => setTimeout(r, 5));
    await q.add('c1', [line('a', 7)]); // counted again while the earlier version is being sent
    release();
    await first;
    expect((await q.pending())[0]!.lines).toEqual([line('a', 7)]);
  });
});
