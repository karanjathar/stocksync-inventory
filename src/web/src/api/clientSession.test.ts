import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiFetch, markSignedIn, AUTH_EXPIRED_EVENT } from './client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { document.cookie = 'ss_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; markSignedIn(false); });

describe('session client', () => {
  it('echoes the CSRF cookie on changes only, and never sends an Authorization header', async () => {
    document.cookie = 'ss_csrf=abc.def; path=/';
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await api('/products', { body: { sku: 'A' } });
    await api('/products');
    const calls = fetchMock.mock.calls as unknown as [string, { method: string; headers: Record<string, string> }][];
    expect(calls[0]![1].headers['x-csrf-token']).toBe('abc.def');
    expect(calls[1]![1].headers['x-csrf-token']).toBeUndefined();
    expect(calls.every(([, init]) => init.headers.authorization === undefined)).toBe(true);
  });

  it('refreshes once when the access cookie has expired, then repeats the request', async () => {
    let first = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') return json({ user: {} });
      if (first) { first = false; return json({ error: { message: 'expired' } }, 401); }
      return json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await api('/orders')).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['/api/orders', '/api/auth/refresh', '/api/orders']);
  });

  it('runs only one refresh for several simultaneous expired requests (refresh tokens are single use)', async () => {
    const state = { fresh: false };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') { await new Promise((r) => setTimeout(r, 20)); state.fresh = true; return json({}); }
      return state.fresh ? json({ ok: 1 }) : json({}, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([api('/a'), api('/b'), api('/c')]);
    expect(fetchMock.mock.calls.filter((c) => (c as unknown as [string])[0] === '/api/auth/refresh')).toHaveLength(1);
  });

  it('tells the app the session is over when refreshing fails', async () => {
    markSignedIn(true);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'no' } }, 401)));
    const expired = vi.fn(); window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    await expect(api('/orders')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  });

  it('does not try to refresh when logging in or out', async () => {
    const fetchMock = vi.fn(async () => json({}, 401));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/auth/login', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
