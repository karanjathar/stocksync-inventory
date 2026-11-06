import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { renderDebitNote } from '../../services/documents.js';
import { requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';
import { sendHtml } from './documents.js';

export const purchaseReturnBodySchema = z.object({
  requestId: z.string().trim().min(1).max(100),
  warehouseId: z.string().uuid(),
  lines: z.array(z.object({ itemId: z.string().uuid(), quantity: z.number().int().positive().max(1_000_000) })).min(1).max(200),
  reason: z.string().trim().max(500).optional(),
});
const listSchema = z.object({ purchaseOrderId: z.string().uuid().optional(), supplierId: z.string().uuid().optional() });

/** Staff only, reads included (supplier finances). POST /purchase-orders/:id/returns lives in purchases.ts. */
export function purchaseReturnRoutes(c: Container): Router {
  const r = Router();
  r.use(requireRole('staff'));
  r.get('/', async (req, res) => { res.json(await c.purchaseReturns.list(parse(listSchema, req.query))); });
  r.get('/:id/print', async (req, res) => {
    const x = await c.purchaseReturns.get(idParam(req));
    if (!x) throw new NotFoundError('Purchase return');
    sendHtml(res, renderDebitNote(x));
  });
  r.get('/:id', async (req, res) => {
    const x = await c.purchaseReturns.get(idParam(req));
    if (!x) throw new NotFoundError('Purchase return');
    res.json(x);
  });
  return r;
}
