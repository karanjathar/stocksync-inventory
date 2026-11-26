import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { streamExport } from '../../services/dataExport.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';

/** Data rights for the signed-in business (administrators): export everything, request deletion, erase a customer. All changes are audited by the trail middleware. */
export function dataRightsRoutes(c: Container): Router {
  const r = Router();
  r.use(requireRole('admin'));
  const exportLimiter = rateLimit({ windowMs: 60 * 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 6, standardHeaders: true, legacyHeaders: false });
  const sensitiveLimiter = rateLimit({ windowMs: 15 * 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: true, legacyHeaders: false });

  // POST (not GET) so that every export is written to the audit trail.
  r.post('/export', exportLimiter, async (req, res) => {
    const tenant = await c.tenants.current();
    if (!tenant) throw new NotFoundError('Business');
    await streamExport(c.pool, res, `stocksync-export-${tenant.slug}-${new Date().toISOString().slice(0, 10)}.zip`, { slug: tenant.slug, name: tenant.name });
  });

  const withSlug = async <T extends object>(state: T) => ({ ...state, slug: (await c.tenants.current())?.slug ?? '' }); // the web address to type when confirming
  r.get('/deletion', async (_req, res) => { res.json(await withSlug(await c.dataRights.deletionState())); });
  r.post('/deletion', sensitiveLimiter, async (req, res) => {
    const user = currentUser(req);
    const { password, confirmSlug } = parse(z.object({ password: z.string().min(1).max(200), confirmSlug: z.string().min(1).max(60) }).strict(), req.body);
    const tenant = await c.tenants.current();
    if (!tenant || confirmSlug !== tenant.slug) throw new ValidationError('Invalid request', [{ path: 'confirmSlug', message: 'type the business web address to confirm' }]);
    await c.auth.login(user.email, password); // proves it is really the administrator at the keyboard (throws 401 otherwise)
    res.status(202).json(await withSlug(await c.dataRights.requestDeletion(user.tenantId, user.email)));
  });
  r.delete('/deletion', async (_req, res) => { res.json(await withSlug(await c.dataRights.cancelDeletion())); });

  r.post('/customers/:id/erase', sensitiveLimiter, async (req, res) => { res.json(await c.dataRights.eraseCustomer(idParam(req))); });
  return r;
}
