import { Router } from 'express';
import type { Container } from '../../container.js';
import { requireRole } from '../middleware/auth.js';

/** Report endpoints (docs/3_SCHEMAS.md §3.15, §3.18). More are added in Phase 13. */
export function reportRoutes(c: Container): Router {
  const r = Router();
  const staff = requireRole('staff');
  r.get('/payables', staff, async (_req, res) => { res.json(await c.bills.payables()); });
  return r;
}
