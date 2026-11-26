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

/**
 * The session lives in httpOnly cookies the page cannot read (so a script injected into the page cannot steal it). The only thing the page
 * reads is the CSRF cookie, which it echoes in a header on every change; the server checks it belongs to the session.
 */
function csrfToken(): string | undefined {
  const m = /(?:^|;\s*)ss_csrf=([^;]+)/.exec(typeof document === 'undefined' ? '' : document.cookie);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

/** True when a browser session probably exists (its CSRF cookie is present), so anonymous visitors do not make a pointless, console-noisy /auth/me call. */
export function hasSessionHint(): boolean { return csrfToken() !== undefined; }

export const AUTH_EXPIRED_EVENT = 'stocksync:auth-expired';
let signedIn = false;
/** Called by the auth provider so an expired session can be told apart from "never signed in". */
export function markSignedIn(v: boolean): void { signedIn = v; }

let refreshing: Promise<boolean> | null = null;
/** One refresh at a time: refresh tokens are single use, so two parallel refreshes would look like a stolen token. */
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', headers: { accept: 'application/json' } })
    .then((r) => r.ok, () => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** fetch() for the API: cookies, CSRF header on changes, and one transparent refresh when the short-lived access cookie has expired. */
export async function apiFetch(path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  const method = init.method ?? 'GET';
  const attempt = () => {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    const csrf = csrfToken();
    if (!SAFE.has(method) && csrf) headers['x-csrf-token'] = csrf;
    return fetch(`/api${path}`, { method, headers, body: init.body, signal: init.signal });
  };
  const res = await attempt();
  if (res.status === 401 && !path.startsWith('/auth/') && (await refreshSession())) return attempt();
  return res;
}

export interface RequestOptions { method?: string; body?: unknown; signal?: AbortSignal }

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiFetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && signedIn && !path.startsWith('/auth/login')) {
      signedIn = false;
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return json as T;
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

/** Fetches a protected PDF and opens it in a new tab. Documents that are created on demand (invoices) are asked for with POST, never a plain link. */
export async function openPdf(path: string, method: 'GET' | 'POST' = 'GET'): Promise<void> {
  const res = await apiFetch(path, { method });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(json.error?.message ?? `Could not open the document (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

