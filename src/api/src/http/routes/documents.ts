import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

/** Documents carry customer data: never cache them, and they are plain HTML with no scripts. */
export function sendHtml(res: Response, html: string): void {
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
  res.send(html);
}

const picklistQuery = z.object({
  orderIds: z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)).pipe(z.array(z.string().uuid()).min(1).max(50)),
});

/** GET /api/picklists?orderIds=a,b,c (staff). The invoice print and packing slip live under /invoices and /orders. */
export function picklistRoutes(c: Container): Router {
  const r = Router();
  r.get('/', requireRole('staff'), async (req, res) => { sendHtml(res, await c.documents.picklist([...new Set(parse(picklistQuery, req.query).orderIds)])); });
  return r;
}
