import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** Runs public/sw.js against a minimal fake service-worker scope so its caching rules are tested, not assumed. */
function loadWorker(online: boolean) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const cache = new Map<string, Response>([['/', new Response('<html>shell</html>')]]);
  const self = { location: { origin: 'https://shop.example.com' }, addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; }, skipWaiting: vi.fn(), clients: { claim: vi.fn() } };
  const caches = {
    open: async () => ({ addAll: async () => {}, put: async (k: Request, v: Response) => { cache.set(new URL(k.url).pathname, v); } }),
    match: async (k: string | Request) => cache.get(typeof k === 'string' ? k : new URL(k.url).pathname),
    keys: async () => [], delete: async () => true,
  };
  const fetchFn = vi.fn(async () => { if (!online) throw new TypeError('Failed to fetch'); return new Response('live'); });
  new Function('self', 'caches', 'fetch', readFileSync(resolve(__dirname, '../public/sw.js'), 'utf8'))(self, caches, fetchFn);
  const request = (path: string, mode = 'cors') => ({ method: 'GET', url: `https://shop.example.com${path}`, mode });
  const handle = async (path: string, mode?: string): Promise<{ handled: boolean; body?: string }> => {
    let result: Promise<Response> | undefined;
    listeners.fetch!({ request: request(path, mode), respondWith: (p: Promise<Response>) => { result = p; } });
    return result ? { handled: true, body: await (await result).text() } : { handled: false };
  };
  return { handle, fetchFn };
}

describe('service worker offline rules', () => {
  it('opening any page offline serves the cached app shell, so the counts page loads and the router takes over', async () => {
    const w = loadWorker(false);
    expect(await w.handle('/stock-counts', 'navigate')).toEqual({ handled: true, body: '<html>shell</html>' });
  });

  it('never intercepts API or webhook calls: stock numbers are always live', async () => {
    const w = loadWorker(false);
    expect(await w.handle('/api/stock-counts/c1/lines')).toEqual({ handled: false });
    expect(await w.handle('/webhooks/meta')).toEqual({ handled: false });
    expect(w.fetchFn).not.toHaveBeenCalled();
  });

  it('online navigation goes to the network first', async () => {
    const w = loadWorker(true);
    expect(await w.handle('/stock-counts', 'navigate')).toEqual({ handled: true, body: 'live' });
  });
});
