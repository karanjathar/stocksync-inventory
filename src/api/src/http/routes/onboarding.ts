import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

/** First-run checklist and sample data for the signed-in business (administrators). */
export function onboardingRoutes(c: Container): Router {
  const r = Router();
  r.use(requireRole('admin'));
  r.get('/', async (_req, res) => { res.json(await c.onboarding.state()); });
  r.post('/dismiss', async (req, res) => { res.json(await c.onboarding.dismiss(parse(z.object({ dismissed: z.boolean() }), req.body).dismissed)); });
  r.post('/demo', async (req, res) => {
    const out = await c.onboarding.addDemo(currentUser(req).id);
    res.status(out.created ? 201 : 200).json(out);
  });
  r.delete('/demo', async (_req, res) => { res.json(await c.onboarding.removeDemo()); });
  return r;
}
