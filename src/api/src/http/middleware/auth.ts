import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../domain/errors.js';
import type { AuthUser, Role } from '../../domain/types.js';
import type { AuthService } from '../../services/auth.js';
import { runWithTenant } from '../../db/tenant.js';

const RANK: Record<Role, number> = { viewer: 1, staff: 2, admin: 3 };

export function requireAuth(auth: AuthService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedError();
    const claims = auth.verify(token);
    // From here on, everything this request does (including every handler after next()) runs as this business.
    await runWithTenant(claims.tid, async () => {
      req.user = await auth.authenticateClaims(claims);
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
