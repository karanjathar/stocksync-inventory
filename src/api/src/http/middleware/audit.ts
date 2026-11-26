import type { RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { runWithTenant } from '../../db/tenant.js';
import { summariseBody } from '../../services/audit.js';

/**
 * Records every successful change a signed-in user makes (any non-GET request that ends below 400): who, what route, which record, which
 * fields (and a short allow-list of safe values). Written just after the response, so it never slows or fails the request; a failure is logged.
 */
export function auditTrail(c: Container): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || !req.user) { next(); return; }
    const user = req.user;
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const params = req.params as Record<string, string | undefined>;
      const entityId = params.id ?? params.code ?? params.kind;
      const base = req.baseUrl.replace(/^\/api/, '');
      const route = typeof req.route?.path === 'string' ? req.route.path : '';
      void runWithTenant(user.tenantId, () => c.audit.record({
        actorId: user.id, actor: user.email, action: `${req.method} ${base}${route === '/' ? '' : route}`,
        entity: base.replace(/^\//, '').split('/')[0] ?? null, entityId: entityId ?? null, detail: summariseBody(req.body), ip: req.ip ?? null,
      })).catch((err: unknown) => c.logger.error({ err: String(err) }, 'audit log write failed'));
    });
    next();
  };
}
