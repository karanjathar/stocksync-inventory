import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

const id = z.string().uuid();
const qty = z.number().int().positive().max(1_000_000);
const reason = z.string().trim().max(500).optional();
const reference = z.string().trim().max(100).optional();
const move = z.object({ productId: id, warehouseId: id, quantity: qty, reason, reference });
const adjust = z.object({ productId: id, warehouseId: id, newQuantity: z.number().int().min(0).max(1_000_000), reason: z.string().trim().min(1).max(500) });
const transfer = z.object({ productId: id, fromWarehouseId: id, toWarehouseId: id, quantity: qty, reason });
const bin = z.object({ productId: id, warehouseId: id, bin: z.string().trim().min(1).max(40).nullable() });
const filter = z.object({ productId: id.optional(), warehouseId: id.optional(), limit: z.coerce.number().int().min(1).max(500).optional() });

export function stockRoutes(c: Container): Router {
  const r = Router();
  const write = requireRole('staff');
  r.get('/', async (req, res) => { res.json(await c.stock.levels(parse(filter, req.query))); });
  r.get('/movements', async (req, res) => { res.json(await c.stock.movements(parse(filter, req.query))); });
  r.put('/bin', write, async (req, res) => { res.json(await c.stock.setBin(parse(bin, req.body))); });
  r.post('/receive', write, async (req, res) => { res.json(await c.stock.receive(parse(move, req.body), currentUser(req).id)); });
  r.post('/issue', write, async (req, res) => { res.json(await c.stock.issue(parse(move, req.body), currentUser(req).id)); });
  r.post('/adjust', write, async (req, res) => { res.json(await c.stock.adjust(parse(adjust, req.body), currentUser(req).id)); });
  r.post('/transfer', write, async (req, res) => { res.json(await c.stock.transfer(parse(transfer, req.body), currentUser(req).id)); });
  return r;
}
