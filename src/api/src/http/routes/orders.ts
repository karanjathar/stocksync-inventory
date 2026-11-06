import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';
import { sendHtml } from './documents.js';

const discountSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), basisPoints: z.number().int().min(0).max(10_000) }),
  z.object({ type: z.literal('fixed'), cents: z.number().int().min(0).max(2_147_483_647) }),
]);
const createSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(100_000), discount: discountSchema.optional() })).min(1).max(100),
  discount: discountSchema.optional(),
  notes: z.string().max(2000).optional(),
  warehouseId: z.string().uuid().optional(),
});
const confirmSchema = z.object({ warehouseId: z.string().uuid().optional() });
const listSchema = z.object({ status: z.enum(['PENDING', 'CONFIRMED', 'FULFILLED', 'CANCELLED']).optional() });

export function orderRoutes(c: Container): Router {
  const r = Router();
  const write = requireRole('staff');
  r.get('/', async (req, res) => { res.json(await c.orders.list(parse(listSchema, req.query))); });
  r.get('/:id/packing-slip', write, async (req, res) => { sendHtml(res, await c.documents.packingSlip(idParam(req))); });
  r.get('/:id', async (req, res) => {
    const o = await c.orders.get(idParam(req));
    if (!o) throw new NotFoundError('Order');
    res.json(o);
  });
  r.post('/', write, async (req, res) => {
    res.status(201).json(await c.orders.create({ ...parse(createSchema, req.body), channel: 'manual' }));
  });
  r.post('/:id/confirm', write, async (req, res) => {
    const { warehouseId } = parse(confirmSchema, req.body ?? {});
    res.json(await c.orders.confirm(idParam(req), warehouseId, currentUser(req).id));
  });
  r.post('/:id/payment-link', write, async (req, res) => {
    const { notify } = parse(z.object({ notify: z.boolean().optional() }), req.body ?? {});
    res.json(await c.payments.sendLink(idParam(req), notify ?? false));
  });
  r.post('/:id/refunded', write, async (req, res) => { res.json(await c.payments.markRefunded(idParam(req))); });
  r.post('/:id/fulfill', write, async (req, res) => { res.json(await c.orders.fulfill(idParam(req))); });
  r.post('/:id/cancel', write, async (req, res) => { res.json(await c.orders.cancel(idParam(req), currentUser(req).id)); });
  return r;
}
