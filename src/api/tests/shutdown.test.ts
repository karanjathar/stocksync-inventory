import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../src/shutdown.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createShutdown', () => {
  it('runs the steps in order, waits for each, then exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown([
      { name: 'http', run: async () => { await sleep(20); order.push('http'); } },
      { name: 'jobs', run: async () => { order.push('jobs'); } },
      { name: 'db', run: async () => { order.push('db'); } },
    ], { timeoutMs: 1000, exit, log: () => {} });
    await shutdown('SIGTERM');
    expect(order).toEqual(['http', 'jobs', 'db']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('a second signal does nothing, and a failing step does not stop the later ones', async () => {
    const ran: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown([
      { name: 'a', run: async () => { throw new Error('boom'); } },
      { name: 'b', run: async () => { ran.push('b'); } },
    ], { timeoutMs: 1000, exit, log: () => {} });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(ran).toEqual(['b']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit 1 when a step hangs past the deadline', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown([{ name: 'hang', run: () => new Promise<void>(() => {}) }], { timeoutMs: 50, exit, log: () => {} });
    void shutdown('SIGTERM');
    await sleep(150);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
