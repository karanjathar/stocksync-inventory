import type { Request, Response } from 'express';

export const ACCESS_COOKIE = 'ss_access';
export const REFRESH_COOKIE = 'ss_refresh';
export const CSRF_COOKIE = 'ss_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Minimal Cookie header parser (first value wins, so a duplicate planted later cannot override the real one). */
export function readCookies(req: Pick<Request, 'headers'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) { try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip undecodable */ } }
  }
  return out;
}

interface CookieOpts { secure: boolean }
const base = (o: CookieOpts) => ({ httpOnly: true, secure: o.secure, sameSite: 'strict' as const });

/** The three session cookies. Access and refresh are httpOnly (script cannot read them); the CSRF cookie is readable on purpose so the page can echo it in a header. */
export function setSessionCookies(res: Response, o: CookieOpts, v: { access: string; refresh: string; csrf: string; refreshDays: number }): void {
  res.cookie(ACCESS_COOKIE, v.access, { ...base(o), path: '/api' });
  res.cookie(REFRESH_COOKIE, v.refresh, { ...base(o), path: '/api/auth', maxAge: v.refreshDays * 86_400_000 });
  res.cookie(CSRF_COOKIE, v.csrf, { httpOnly: false, secure: o.secure, sameSite: 'strict', path: '/', maxAge: v.refreshDays * 86_400_000 }); // lives as long as the session, and doubles as the page's hint that one exists
}

export function clearSessionCookies(res: Response, o: CookieOpts): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(o), path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { ...base(o), path: '/api/auth' });
  res.clearCookie(CSRF_COOKIE, { httpOnly: false, secure: o.secure, sameSite: 'strict', path: '/' });
}
