import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { isoDate, parse } from '../validate.js';
import { purchaseReturnBodySchema } from './purchaseReturns.js';

const line = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(1_000_000),
  unitCostCents: z.number().int().min(0).max(1_000_000_000),
});
const items = z.array(line).min(1).max(200);
const createSchema = z.object({
  supplierId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  expectedDate: isoDate.nullable().optional(),
  notes: z.string().max(2000).optional(),
  items,
});
const patchSchema = createSchema.partial();
const receiveSchema = z.object({
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    quantity: z.number().int().positive().max(1_000_000),
    warehouseId: z.string().uuid().optional(),
  })).min(1).max(200),
});
const listSchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']).optional(),
  supplierId: z.string().uuid().optional(),
});

export function purchaseRoutes(c: Container): Router {
  const r = Router();
  const write = requireRole('staff');
  r.get('/', async (req, res) => { res.json(await c.purchases.list(parse(listSchema, req.query))); });
  r.get('/:id', async (req, res) => {
    const po = await c.purchases.get(idParam(req));
    if (!po) throw new NotFoundError('Purchase order');
    res.json(po);
  });
  r.post('/', write, async (req, res) => {
    res.status(201).json(await c.purchases.create({ ...parse(createSchema, req.body), userId: currentUser(req).id }));
  });
  r.patch('/:id', write, async (req, res) => { res.json(await c.purchases.update(idParam(req), parse(patchSchema, req.body))); });
  r.post('/:id/send', write, async (req, res) => { res.json(await c.purchases.send(idParam(req))); });
  r.post('/:id/receive', write, async (req, res) => {
    res.json(await c.purchases.receive(idParam(req), parse(receiveSchema, req.body).lines, currentUser(req).id));
  });
  r.post('/:id/close', write, async (req, res) => { res.json(await c.purchases.close(idParam(req))); });
  r.post('/:id/returns', write, async (req, res) => {
    const { purchaseReturn, created } = await c.purchaseReturns.create(idParam(req), parse(purchaseReturnBodySchema, req.body), currentUser(req).id);
    res.status(created ? 201 : 200).json(purchaseReturn);
  });
  r.post('/:id/cancel', write, async (req, res) => { res.json(await c.purchases.cancel(idParam(req))); });
  return r;
}
