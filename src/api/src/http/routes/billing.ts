import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

const planSchema = z.object({ plan: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/) }).strict(); // only a plan code: price and Razorpay plan id are read from our records

/** Subscription management for the signed-in business (administrators). The plan changes only when Razorpay's signed webhook says so. */
export function billingRoutes(c: Container): Router {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: true, legacyHeaders: false });
  r.use(requireRole('admin'));
  r.get('/', async (_req, res) => { res.json(await c.billing.state()); });
  r.post('/subscribe', limiter, async (req, res) => { res.status(201).json(await c.billing.subscribe(parse(planSchema, req.body).plan, currentUser(req).tenantId)); });
  r.post('/change', limiter, async (req, res) => { await c.billing.changePlan(parse(planSchema, req.body).plan); res.json(await c.billing.state()); });
  r.post('/cancel', limiter, async (_req, res) => { await c.billing.cancel(); res.json(await c.billing.state()); });
  return r;
}
