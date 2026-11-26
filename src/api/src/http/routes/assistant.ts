import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

const askSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) })).max(12).default([]),
}).strict();

/** The staff assistant: read-only questions about the signed-in business. Any signed-in role may ask (it cannot change anything). */
export function assistantRoutes(c: Container): Router {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `assistant:${req.user!.id}` });
  r.use(requireRole('viewer'));
  r.get('/status', async (_req, res) => { res.json({ available: await c.assistant.available() }); });
  r.post('/ask', limiter, async (req, res) => {
    const { question, history } = parse(askSchema, req.body);
    res.set('Cache-Control', 'no-store').json(await c.assistant.ask(question, history));
  });
  return r;
}
