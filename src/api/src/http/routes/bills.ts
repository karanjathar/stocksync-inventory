import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { isoDate, parse } from '../validate.js';

const amount = z.number().int().positive().max(2_000_000_000);
const createSchema = z.object({
  purchaseOrderId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  amountCents: amount.optional(),
  dueDate: isoDate.optional(),
});
const paymentSchema = z.object({
  requestId: z.string().trim().min(1).max(100),
  amountCents: amount,
  method: z.string().trim().min(1).max(40),
});
const listSchema = z.object({
  status: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'VOID']).optional(),
  supplierId: z.string().uuid().optional(),
});

export function billRoutes(c: Container): Router {
  const r = Router();
  const write = requireRole('staff');
  r.get('/', write, async (req, res) => { res.json(await c.bills.list(parse(listSchema, req.query))); });
  r.get('/:id', write, async (req, res) => {
    const bill = await c.bills.get(idParam(req));
    if (!bill) throw new NotFoundError('Bill');
    res.json(bill);
  });
  r.post('/', write, async (req, res) => { res.status(201).json(await c.bills.create(parse(createSchema, req.body))); });
  r.post('/:id/payments', write, async (req, res) => { res.json(await c.bills.pay(idParam(req), parse(paymentSchema, req.body))); });
  r.post('/:id/void', write, async (req, res) => { res.json(await c.bills.void(idParam(req))); });
  return r;
}
