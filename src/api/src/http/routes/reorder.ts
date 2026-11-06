import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

const createSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(200),
  warehouseId: z.string().uuid().optional(),
});

export function reorderRoutes(c: Container): Router {
  const r = Router();
  r.get('/', async (_req, res) => { res.json(await c.reorder.suggestions()); });
  r.post('/', requireRole('staff'), async (req, res) => {
    const b = parse(createSchema, req.body);
    res.status(201).json(await c.reorder.createDrafts([...new Set(b.productIds)], b.warehouseId, currentUser(req).id));
  });
  return r;
}
