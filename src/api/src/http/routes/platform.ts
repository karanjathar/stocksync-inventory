import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotConfiguredError, UnauthorizedError } from '../../domain/errors.js';
import type { PlatformAdmin } from '../../services/platform.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';

declare module 'express-serve-static-core' { interface Request { platformAdmin?: PlatformAdmin } }

/** Platform console (T91). Separate login and token from any business; no route here reads business data. */
export function platformRoutes(c: Container): Router {
  const r = Router();
  const platform = c.platform;
  if (!platform) { r.use(() => { throw new NotConfiguredError('The platform console'); }); return r; }
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false });
  const requirePlatform: RequestHandler = async (req, _res, next) => {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedError();
    req.platformAdmin = await platform.authenticate(token);
    next();
  };
  r.post('/login', limiter, async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().trim().min(1).max(320), password: z.string().min(1).max(200) }), req.body);
    res.json(await platform.login(email, password));
  });
  r.get('/tenants', requirePlatform, async (_req, res) => { res.json(await platform.listTenants()); });
  r.patch('/tenants/:id', requirePlatform, async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }), req.body);
    res.json(await platform.setStatus(idParam(req), status));
  });
  return r;
}
