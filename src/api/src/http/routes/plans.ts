import { Router } from 'express';
import type { Container } from '../../container.js';
import { requireRole } from '../middleware/auth.js';

/** What the signed-in business has used of its plan (administrators). */
export function usageRoutes(c: Container): Router {
  const r = Router();
  r.get('/', requireRole('admin'), async (_req, res) => { res.json(await c.plans.usage()); });
  return r;
}
