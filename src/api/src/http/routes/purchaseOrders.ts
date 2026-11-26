import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';

const line = z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(1_000_000), unitCostCents: z.number().int().min(0).max(1_000_000_000) });
const createSchema = z.object({ supplierId: z.string().uuid(), warehouseId: z.string().uuid(), lines: z.array(line).min(1).max(200), notes: z.string().max(2000).optional() });
const patchSchema = z.object({ supplierId: z.string().uuid().optional(), warehouseId: z.string().uuid().optional(), lines: z.array(line).min(1).max(200).optional(), notes: z.string().max(2000).optional() });
const receiveSchema = z.object({
  receiptId: z.string().trim().min(1).max(64),
  lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(1_000_000) })).min(1).max(200),
});
const listSchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']).optional(),
  supplierId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function purchaseOrderRoutes(c: Container): Router {
  const r = Router();
  const write = requireRole('staff');
  r.get('/', async (req, res) => { res.json(await c.purchaseOrders.list(parse(listSchema, req.query))); });
  r.get('/:id', async (req, res) => {
    const po = await c.purchaseOrders.get(idParam(req));
    if (!po) throw new NotFoundError('Purchase order');
    res.json(po);
  });
  r.post('/', write, async (req, res) => { res.status(201).json(await c.purchaseOrders.create(parse(createSchema, req.body), currentUser(req).id)); });
  r.patch('/:id', write, async (req, res) => { res.json(await c.purchaseOrders.update(idParam(req), parse(patchSchema, req.body))); });
  r.post('/:id/send', write, async (req, res) => { res.json(await c.purchaseOrders.send(idParam(req))); });
  r.post('/:id/cancel', write, async (req, res) => { res.json(await c.purchaseOrders.cancel(idParam(req))); });
  r.post('/:id/receive', write, async (req, res) => {
    const { receiptId, lines } = parse(receiveSchema, req.body);
    res.json(await c.purchaseOrders.receive(idParam(req), receiptId, lines, currentUser(req).id));
  });
  return r;
}

export function reorderRoutes(c: Container): Router {
  const r = Router();
  r.get('/', async (_req, res) => { res.json({ suggestions: await c.reorder.suggestions() }); });
  r.post('/create-pos', requireRole('staff'), async (req, res) => {
    const { productIds } = parse(z.object({ productIds: z.array(z.string().uuid()).min(1).max(500).optional() }), req.body ?? {});
    res.status(201).json(await c.reorder.createPurchaseOrders(productIds, currentUser(req).id));
  });
  return r;
}

