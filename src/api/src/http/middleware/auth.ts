import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../domain/errors.js';
import type { AuthUser, Role } from '../../domain/types.js';
import type { AuthService } from '../../services/auth.js';
import { runWithTenant } from '../../db/tenant.js';
import type { SessionService } from '../../services/sessions.js';
import { ACCESS_COOKIE, CSRF_HEADER, readCookies } from '../cookies.js';

const RANK: Record<Role, number> = { viewer: 1, staff: 2, admin: 3 };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A bearer token (API clients) or the browser's httpOnly access cookie. A COOKIE can be sent by any page the browser visits, so a request
 * authenticated by cookie that changes something must also carry the CSRF token bound to its session; bearer tokens need no such proof
 * because a browser never attaches them by itself. A cookie token must belong to a session that has not been ended.
 */
export function requireAuth(auth: AuthService, sessions?: SessionService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, bearer] = header.split(' ');
    const cookie = scheme === 'Bearer' && bearer ? undefined : readCookies(req)[ACCESS_COOKIE];
    const token = scheme === 'Bearer' && bearer ? bearer : cookie;
    if (!token) throw new UnauthorizedError();
    const claims = auth.verify(token);
    if (cookie !== undefined) {
      if (!claims.sid || !sessions) throw new UnauthorizedError();
      if (!SAFE_METHODS.has(req.method) && !sessions.verifyCsrf(req.header(CSRF_HEADER), claims.sid)) throw new ForbiddenError('Missing or invalid CSRF token');
    }
    // From here on, everything this request does (including every handler after next()) runs as this business.
    await runWithTenant(claims.tid, async () => {
      req.user = await auth.authenticateClaims(claims);
      if (claims.sid && sessions && !(await sessions.isFamilyActive(claims.sid))) throw new UnauthorizedError('Invalid or expired token'); // this session was ended
      next();
    });
  };
}

/** Allows the given role and any higher role (admin > staff > viewer). */
export function requireRole(min: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw new UnauthorizedError();
    if (RANK[req.user.role] < RANK[min]) throw new ForbiddenError();
    next();
  };
}

export function currentUser(req: { user?: AuthUser }): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}
