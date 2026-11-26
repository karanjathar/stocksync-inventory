import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(80).regex(/^[0-9T:. +\-Z]+\|[0-9a-f-]{36}$/i).optional(),
  action: z.string().trim().max(100).optional(),
  actor: z.string().trim().max(100).optional(),
});

/** The business's own change history (administrators). Read-only: there is no route, and no database permission, to alter it. */
export function auditRoutes(c: Container): Router {
  const r = Router();
  r.get('/', requireRole('admin'), async (req, res) => { res.json(await c.audit.list(parse(query, req.query))); });
  return r;
}
