import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Installs a fetch mock answering by "METHOD /path" (or "/path" for GET). */
export function mockApi(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '') + url.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const handler = routes[`${method} ${path}`] ?? (method === 'GET' ? routes[path] : undefined);
    if (handler === undefined) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no mock for ${method} ${path}` } }), { status: 404 });
    const value = typeof handler === 'function' ? (handler as (b: unknown) => unknown)(body) : handler;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
