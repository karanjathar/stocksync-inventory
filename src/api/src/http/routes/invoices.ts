import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';

const listSchema = z.object({
  status: z.enum(['ISSUED', 'VOID']).optional(),
  orderId: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(9999).optional(),
});

/** Read-only by design: invoices are issued by confirming an order and voided by cancelling it. Staff only. */
export function invoiceRoutes(c: Container): Router {
  const r = Router();
  r.get('/', async (req, res) => { res.json(await c.invoices.list(parse(listSchema, req.query))); });
  r.get('/:id', async (req, res) => {
    const inv = await c.invoices.get(idParam(req));
    if (!inv) throw new NotFoundError('Invoice');
    res.json(inv);
  });
  return r;
}
