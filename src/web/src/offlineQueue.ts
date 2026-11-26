import { ApiError } from './api/client';

export interface CountLine { productId: string; countedQuantity: number }
export interface QueuedCount { countId: string; lines: CountLine[]; queuedAt: number }
export interface FlushResult { sent: string[]; conflicts: { countId: string; message: string }[]; stopped: boolean }

const STORE = 'counts';

/**
 * Stock-count lines captured while offline, kept in IndexedDB so they survive a reload and a closed tab.
 * One entry per count: lines merge by product, the latest quantity wins (the server also uses last-write-wins, so merging changes nothing).
 */
export class OfflineQueue {
  private db: Promise<IDBDatabase> | null = null;
  private flushing: Promise<FlushResult> | null = null;

  constructor(private readonly name = 'stocksync-offline') {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'countId' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
    });
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB write aborted'));
    });
  }

  async add(countId: string, lines: CountLine[]): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      const get = store.get(countId); // read and write in ONE transaction, so two adds cannot lose each other's lines
      get.onsuccess = () => {
        const existing = get.result as QueuedCount | undefined;
        const merged = new Map((existing?.lines ?? []).map((l) => [l.productId, l]));
        for (const l of lines) merged.set(l.productId, l);
        store.put({ countId, lines: [...merged.values()], queuedAt: existing?.queuedAt ?? Date.now() } satisfies QueuedCount);
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB write aborted'));
    });
  }

  async pending(): Promise<QueuedCount[]> {
    return (await this.tx('readonly', (s) => s.getAll() as IDBRequest<QueuedCount[]>)).sort((a, b) => a.queuedAt - b.queuedAt);
  }

  async size(): Promise<number> { return this.tx('readonly', (s) => s.count()); }

  /** Removes an entry only if nothing was added to it since `snapshot` was read. */
  private async removeIfUnchanged(snapshot: QueuedCount): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      const get = store.get(snapshot.countId);
      get.onsuccess = () => {
        const cur = get.result as QueuedCount | undefined;
        if (cur && JSON.stringify(cur.lines) === JSON.stringify(snapshot.lines)) store.delete(snapshot.countId);
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
    });
  }

  /**
   * Sends queued counts oldest first. A network problem or server error stops the run and keeps everything left; a count the server no longer
   * accepts (submitted or cancelled meanwhile, gone, or invalid) is dropped and reported so the person can see what did not go through.
   * Overlapping calls share one run.
   */
  flush(send: (item: QueuedCount) => Promise<void>): Promise<FlushResult> {
    this.flushing ??= this.run(send).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async run(send: (item: QueuedCount) => Promise<void>): Promise<FlushResult> {
    const result: FlushResult = { sent: [], conflicts: [], stopped: false };
    for (const item of await this.pending()) {
      try {
        await send(item);
        await this.removeIfUnchanged(item);
        result.sent.push(item.countId);
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          result.conflicts.push({ countId: item.countId, message: err.message });
          await this.removeIfUnchanged(item);
        } else {
          result.stopped = true; // offline, timeout or a 5xx: keep this item and everything after it
          break;
        }
      }
    }
    return result;
  }
}

export const offlineQueue = new OfflineQueue();
