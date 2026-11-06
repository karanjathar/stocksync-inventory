import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';

const rate = z.number().int().min(0).max(10_000);
const createSchema = z.object({ name: z.string().trim().min(1).max(60), rateBp: rate });
const patchSchema = z.object({ name: z.string().trim().min(1).max(60).optional(), rateBp: rate.optional(), active: z.boolean().optional() });

export function taxRateRoutes(c: Container): Router {
  const r = Router();
  const admin = requireRole('admin');
  r.get('/', async (_req, res) => { res.json(await c.taxRates.list()); });
  r.post('/', admin, async (req, res) => { res.status(201).json(await c.taxRates.create(parse(createSchema, req.body))); });
  r.patch('/:id', admin, async (req, res) => { res.json(await c.taxRates.update(idParam(req), parse(patchSchema, req.body))); });
  return r;
}
