import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { runWithTenant } from '../../db/tenant.js';
import { NotFoundError, UnauthorizedError } from '../../domain/errors.js';
import type { User } from '../../domain/types.js';
import { ACCESS_TTL, REFRESH_TTL_DAYS } from '../../services/sessions.js';
import { clearSessionCookies, readCookies, REFRESH_COOKIE, setSessionCookies } from '../cookies.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';

const loginSchema = z.object({ email: z.string().trim().min(1).max(320), password: z.string().min(1).max(200) });

export function authRoutes(c: Container): Router {
  const r = Router();
  const test = c.env.NODE_ENV === 'test';
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: test ? 1000 : 20, standardHeaders: true, legacyHeaders: false });
  const refreshLimiter = rateLimit({ windowMs: 60_000, limit: test ? 1000 : 60, standardHeaders: true, legacyHeaders: false });
  // Cookies are marked Secure whenever the public address is https (always, in production). Plain http is only for local development.
  const secure = new URL(c.env.PUBLIC_BASE_URL).protocol === 'https:';
  const auth = requireAuth(c.auth, c.sessions);

  /** Starts a NEW session for a user and sets its cookies. Anything the browser already had is ignored and overwritten (no session fixation). */
  const startBrowserSession = async (res: Response, user: Pick<User, 'id' | 'email' | 'role'>, tenantId: string): Promise<void> => {
    const { familyId, refresh } = await runWithTenant(tenantId, () => c.sessions.start(user.id));
    setSessionCookies(res, { secure }, { access: c.auth.sign(user, tenantId, ACCESS_TTL, familyId), refresh, csrf: c.sessions.csrfFor(familyId), refreshDays: REFRESH_TTL_DAYS });
  };

  r.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    await c.loginGuard.check(email, req.ip); // before the password is looked at: a correct password does not get through while locked
    let signedIn: Awaited<ReturnType<typeof c.auth.login>>;
    try {
      signedIn = await c.auth.login(email, password);
    } catch (err) {
      if (err instanceof UnauthorizedError) await c.loginGuard.failure(email, req.ip);
      throw err;
    }
    await c.loginGuard.success(email);
    const { token, user, tenantId } = signedIn;
    await startBrowserSession(res, user, tenantId);
    res.set('Cache-Control', 'no-store').json({ token, user }); // `token` is for API clients that prefer a bearer header; the web app ignores it and relies on the cookies
  });

  /** Trades the refresh cookie for a fresh access cookie and the next refresh token. A replayed token ends the whole session. */
  r.post('/refresh', refreshLimiter, async (req, res) => {
    const presented = readCookies(req)[REFRESH_COOKIE];
    if (!presented) throw new UnauthorizedError('Session expired');
    try {
      const next = await c.sessions.rotate(presented);
      const user = await runWithTenant(next.tenantId, async () => {
        const u = await c.repos.users.findById(next.userId);
        if (!u) throw new UnauthorizedError('Session expired');
        // The same checks as any request: the business must still be active and the user must not have been logged out everywhere since.
        await c.auth.authenticateClaims({ sub: u.id, tid: next.tenantId, at: Date.now() });
        return u;
      });
      setSessionCookies(res, { secure }, { access: c.auth.sign(user, next.tenantId, ACCESS_TTL, next.familyId), refresh: next.refresh, csrf: c.sessions.csrfFor(next.familyId), refreshDays: REFRESH_TTL_DAYS });
      res.set('Cache-Control', 'no-store').json({ user });
    } catch (err) {
      clearSessionCookies(res, { secure });
      throw err;
    }
  });

  r.post('/logout', auth, async (req, res) => {
    const sid = readSid(req.headers.cookie, c);
    if (sid) await c.sessions.revokeFamily(sid);
    clearSessionCookies(res, { secure });
    res.status(204).end();
  });
  r.post('/logout-all', auth, async (req, res) => {
    await c.sessions.revokeAll(currentUser(req).id);
    clearSessionCookies(res, { secure });
    res.status(204).end();
  });

  const pwSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) });
  r.post('/password', loginLimiter, auth, async (req, res) => {
    const { currentPassword, newPassword } = parse(pwSchema, req.body);
    const me = currentUser(req);
    await c.auth.changePassword(me.email, currentPassword, newPassword);
    await c.sessions.revokeAll(me.id); // a changed password ends every other session (and this one: the browser is given a fresh one below)
    await startBrowserSession(res, me, me.tenantId);
    res.status(204).end();
  });
  r.get('/me', auth, async (req, res) => {
    const user = await c.repos.users.findById(currentUser(req).id);
    if (!user) throw new NotFoundError('User');
    res.json(user);
  });
  return r;
}

/** The session family of the access cookie, if the request came with one. */
function readSid(cookieHeader: string | undefined, c: Container): string | undefined {
  const access = readCookies({ headers: { cookie: cookieHeader } })['ss_access'];
  if (!access) return undefined;
  try { return c.auth.verify(access).sid; } catch { return undefined; }
}
