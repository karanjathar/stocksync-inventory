import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotFoundError } from '../../domain/errors.js';
import { crudRoutes } from '../crud.js';
import { requireRole } from '../middleware/auth.js';
import { idParam } from '../params.js';
import { parse } from '../validate.js';

const name = z.string().trim().min(1).max(120);

export function categoryRoutes(c: Container): Router {
  const s = z.object({ name });
  return crudRoutes({ entity: 'Category', repo: c.repos.categories, create: s, patch: s.partial() });
}

const productBase = z.object({
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_.-]{0,63}$/, 'SKU may contain only letters, digits, - _ .'),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  priceCents: z.number().int().min(0).max(1_000_000_000),
  taxRateId: z.string().uuid().nullable().optional(),
  reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
  reorderQuantity: z.number().int().min(0).max(1_000_000).optional(),
  preferredSupplierId: z.string().uuid().nullable().optional(),
  imageUrl: z.string().url().max(2000).refine((u) => /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(u), 'must be an https URL').nullable().optional(),
  attributes: z.record(z.string().trim().min(1).max(64), z.string().max(500))
    .refine((a) => Object.keys(a).length <= 50, 'at most 50 attributes').optional(),
  isActive: z.boolean().optional(),
});

const listQuery = z.object({
  search: z.string().max(200).optional(),
  categoryId: z.string().uuid().optional(),
  lowStock: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export function productRoutes(c: Container): Router {
  const r = Router();
  const write = requireRole('staff');
  r.get('/', async (req, res) => {
    res.json(await c.repos.products.list(parse(listQuery, req.query)));
  });
  r.get('/:id', async (req, res) => {
    const p = await c.repos.products.get(idParam(req));
    if (!p) throw new NotFoundError('Product');
    res.json(p);
  });
  r.post('/', write, async (req, res) => {
    res.status(201).json(await c.repos.products.create(parse(productBase, req.body)));
  });
  r.patch('/:id', write, async (req, res) => {
    const p = await c.repos.products.update(idParam(req), parse(productBase.partial(), req.body));
    if (!p) throw new NotFoundError('Product');
    res.json(p);
  });
  r.delete('/:id', write, async (req, res) => {
    if (!(await c.repos.products.delete(idParam(req)))) throw new NotFoundError('Product');
    res.status(204).end();
  });
  return r;
}

export function warehouseRoutes(c: Container): Router {
  const s = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/, 'code may contain only letters, digits, - _'),
    name,
    address: z.string().trim().max(500).optional(),
  });
  return crudRoutes({ entity: 'Warehouse', repo: c.repos.warehouses, create: s, patch: s.partial() });
}

const optEmail = z.string().trim().email().max(320).nullable().optional();
const optPhone = z.string().trim().regex(/^\+?[0-9 ()-]{5,20}$/, 'invalid phone').nullable().optional();

export function supplierRoutes(c: Container): Router {
  const s = z.object({ name, email: optEmail, phone: optPhone, notes: z.string().max(2000).optional() });
  return crudRoutes({ entity: 'Supplier', repo: c.repos.suppliers, create: s, patch: s.partial() });
}

export function customerRoutes(c: Container): Router {
  const s = z.object({ name, email: optEmail, phone: optPhone });
  return crudRoutes({ entity: 'Customer', repo: c.customers, create: s, patch: s.partial() });
}
