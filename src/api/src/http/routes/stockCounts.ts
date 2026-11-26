import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';

const linesSchema = z.object({
  lines: z.array(z.object({ productId: z.string().uuid(), countedQuantity: z.number().int().min(0).max(10_000_000) })).min(1).max(500),
});

export function stockCountRoutes(c: Container): Router {
  const r = Router();
  const write = requireRole('staff');
  r.get('/', async (req, res) => { res.json(await c.stockCounts.list(parse(z.object({ status: z.enum(['OPEN', 'SUBMITTED', 'CANCELLED']).optional() }), req.query).status)); });
  r.get('/:id', async (req, res) => {
    const sc = await c.stockCounts.get(idParam(req));
    if (!sc) throw new NotFoundError('Stock count');
    res.json(sc);
  });
  r.post('/', write, async (req, res) => {
    res.status(201).json(await c.stockCounts.open(parse(z.object({ warehouseId: z.string().uuid() }), req.body).warehouseId, currentUser(req).id));
  });
  r.put('/:id/lines', write, async (req, res) => { res.json(await c.stockCounts.setLines(idParam(req), parse(linesSchema, req.body).lines)); });
  r.post('/:id/submit', write, async (req, res) => { res.json(await c.stockCounts.submit(idParam(req), currentUser(req).id)); });
  r.post('/:id/cancel', write, async (req, res) => { res.json(await c.stockCounts.cancel(idParam(req))); });
  return r;
}
