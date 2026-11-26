import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { idParam } from '../params.js';

const role = z.enum(['admin', 'staff', 'viewer']);
const createSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(120),
  role,
});
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: role.optional(),
  password: z.string().min(8).max(200).optional(),
});

export function userRoutes(c: Container): Router {
  const r = Router();
  r.use(requireRole('admin'));
  r.get('/', async (_req, res) => { res.json(await c.repos.users.list()); });
  r.post('/', async (req, res) => {
    const input = parse(createSchema, req.body);
    await c.plans.assertCanAdd('users');
    res.status(201).json(await c.auth.createUser(input));
  });
  r.patch('/:id', async (req, res) => {
    res.json(await c.auth.updateUser(idParam(req), parse(patchSchema, req.body)));
  });
  r.delete('/:id', async (req, res) => {
    const id = idParam(req);
    if (id === currentUser(req).id) throw new ConflictError('You cannot delete your own account');
    if (!(await c.repos.users.delete(id))) throw new NotFoundError('User');
    res.status(204).end();
  });
  return r;
}
