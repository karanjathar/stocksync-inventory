import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { renderCreditNote } from '../../services/documents.js';
import { requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';
import { sendHtml } from './documents.js';

export const returnBodySchema = z.object({
  requestId: z.string().trim().min(1).max(100),
  warehouseId: z.string().uuid(),
  lines: z.array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().positive().max(100_000) })).min(1).max(100),
  reason: z.string().trim().max(500).optional(),
});
const listSchema = z.object({
  orderId: z.string().uuid().optional(),
  refundStatus: z.enum(['NOT_REQUIRED', 'REFUND_DUE', 'REFUNDED']).optional(),
});

/** Staff only, reads included: returns and credit notes expose customer and money details. POST /orders/:id/returns lives in orders.ts. */
export function returnRoutes(c: Container): Router {
  const r = Router();
  r.use(requireRole('staff')); // mounted at /returns, so this guard covers only this resource
  r.get('/', async (req, res) => { res.json(await c.returns.list(parse(listSchema, req.query))); });
  r.get('/:id', async (req, res) => {
    const x = await c.returns.get(idParam(req));
    if (!x) throw new NotFoundError('Return');
    res.json(x);
  });
  r.post('/:id/refunded', async (req, res) => { res.json(await c.returns.markRefunded(idParam(req))); });
  return r;
}

export function creditNoteRoutes(c: Container): Router {
  const r = Router();
  r.use(requireRole('staff'));
  r.get('/', async (_req, res) => { res.json(await c.returns.creditNotes()); });
  r.get('/:id/print', async (req, res) => {
    const cn = await c.returns.creditNote(idParam(req));
    if (!cn) throw new NotFoundError('Credit note');
    sendHtml(res, renderCreditNote(cn));
  });
  r.get('/:id', async (req, res) => {
    const cn = await c.returns.creditNote(idParam(req));
    if (!cn) throw new NotFoundError('Credit note');
    res.json(cn);
  });
  return r;
}
