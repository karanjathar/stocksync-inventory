import { Router } from 'express';
import type { Container } from '../../container.js';

export function paymentRoutes(c: Container): Router {
  const r = Router();
  r.get('/config', async (_req, res) => { res.json(await c.payments.config()); });
  return r;
}
