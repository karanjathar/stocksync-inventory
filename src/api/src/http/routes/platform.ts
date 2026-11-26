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
  r.get('/tenants', requirePlatform, async (_req, res) => { res.json(await platform.overview()); });
  r.get('/queue', requirePlatform, async (_req, res) => { res.json(await platform.queueOverview()); });
  r.patch('/tenants/:id', requirePlatform, async (req, res) => {
    const { status, plan } = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), plan: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/).optional() })
      .refine((v) => v.status !== undefined || v.plan !== undefined, 'status or plan is required'), req.body);
    const id = idParam(req);
    if (plan) { await c.planAdmin!.assign(id, plan); await platform.audit(id, req.platformAdmin!, { action: 'PLATFORM plan change', detail: { values: { plan } } }); }
    if (status) { await platform.setStatus(id, status); await platform.audit(id, req.platformAdmin!, { action: status === 'SUSPENDED' ? 'PLATFORM suspend' : 'PLATFORM unsuspend', detail: { values: { status } } }); }
    res.json((await platform.listTenants()).find((t) => t.id === id));
  });
  const limit = z.number().int().min(0).nullable();
  r.get('/plans', requirePlatform, async (_req, res) => { res.json(await c.planAdmin!.list()); });
  r.put('/plans/:code', requirePlatform, async (req, res) => {
    const code = parse(z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/), req.params.code);
    const edit = parse(z.object({ name: z.string().trim().min(1).max(60), priceMinor: z.number().int().min(0).max(100_000_000), active: z.boolean(), sort: z.number().int().min(0).max(1000),
      maxProducts: limit, maxUsers: z.number().int().min(1).nullable(), maxChatMessages: limit, maxInvoices: limit, razorpayPlanId: z.string().regex(/^plan_[A-Za-z0-9]{6,40}$/).nullable() }).partial(), req.body);
    res.json(await c.planAdmin!.upsert(code, edit));
  });
  return r;
}
