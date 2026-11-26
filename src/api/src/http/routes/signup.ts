import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { NotConfiguredError, ValidationError } from '../../domain/errors.js';
import { parse } from '../validate.js';

const startSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(10).max(200),
  businessName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().max(40),
});

/** Anonymous sign-up. Answers are identical for new, existing and throttled email addresses (no account enumeration). */
export function signupRoutes(c: Container): Router {
  const r = Router();
  const test = c.env.NODE_ENV === 'test';
  const perIp = rateLimit({ windowMs: 60 * 60_000, limit: test ? 1000 : 10, standardHeaders: true, legacyHeaders: false });
  const emailOf = (body: unknown) => (typeof (body as { email?: unknown } | undefined)?.email === 'string' ? (body as { email: string }).email.trim().toLowerCase() : 'none');
  const perEmail = rateLimit({ windowMs: 60 * 60_000, limit: test ? 1000 : 5, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `email:${emailOf(req.body)}`, validate: { keyGeneratorIpFallback: false } });
  const verifyLimiter = rateLimit({ windowMs: 15 * 60_000, limit: test ? 1000 : 30, standardHeaders: true, legacyHeaders: false });
  const accepted = { message: 'If the details are valid, we have sent a confirmation link to that email address.' };

  r.use((_req, _res, next) => { if (!c.signup) throw new NotConfiguredError('Sign-up'); next(); });
  r.post('/', perIp, perEmail, async (req, res) => {
    await c.signup!.start(parse(startSchema, req.body));
    res.status(202).json(accepted);
  });
  r.post('/resend', perIp, perEmail, async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(320) }), req.body);
    await c.signup!.resend(email);
    res.status(202).json(accepted);
  });
  r.post('/verify', verifyLimiter, async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
    const created = await c.signup!.verify(token);
    if (!created) throw new ValidationError('This link is invalid or has expired. Request a new one.');
    res.status(201).json({ slug: created.slug });
  });
  return r;
}
