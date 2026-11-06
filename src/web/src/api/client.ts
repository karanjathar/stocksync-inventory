const TOKEN_KEY = 'stocksync.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function read(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

let token: string | null = read();

export function getToken(): string | null { return token; }

export function setToken(t: string | null): void {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable (private mode) — keep in memory only */ }
}

export const AUTH_EXPIRED_EVENT = 'stocksync:auth-expired';

export interface RequestOptions { method?: string; body?: unknown; signal?: AbortSignal }

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/auth/login')) {
      setToken(null);
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return json as T;
}

/** GETs a text/HTML document (printable invoices etc.) with the session token. Errors are reported like JSON API errors. */
export async function apiText(path: string): Promise<string> {
  const res = await fetch(`/api${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const json: unknown = await res.json().catch(() => ({}));
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status})`);
  }
  return res.text();
}

/** Field-level messages from a 400 VALIDATION_ERROR, joined for display. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details)) {
      const parts = (err.details as { path?: string; message?: string }[]).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message));
      return `${err.message} — ${parts.join('; ')}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
