import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { Container } from '../../container.js';
import { AppError } from '../../domain/errors.js';

/** Per-business request budget from the plan (requests per minute), shared by everyone signed in to that business. Cached briefly so it is not a query per request. */
export class PlanRateLimits {
  private readonly cache = new Map<string, { limit: number; until: number }>();
  constructor(private readonly lookup: () => Promise<number>, private readonly ttlMs = 30_000) {}

  async limitFor(tenantId: string): Promise<number> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.until > Date.now()) return hit.limit;
    const limit = await this.lookup(); // runs inside the request's business context
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(tenantId, { limit, until: Date.now() + this.ttlMs });
    return limit;
  }
}

/**
 * After sign-in: one counter per BUSINESS (not per address, not per user), sized by its plan. A noisy business cannot use up another's budget, and a
 * bigger plan buys more. Counters live in this replica's memory, so with several replicas a business can reach up to limit × replicas per minute;
 * the platform-wide per-address limiter in front still applies to everyone.
 */
export function tenantRateLimit(c: Container): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: async (req) => c.rateLimits.limitFor(req.user!.tenantId),
    keyGenerator: (req) => `tenant:${req.user!.tenantId}`,
    standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, _res, next) => { next(new AppError(429, 'RATE_LIMITED', 'Your business is sending too many requests for its plan. Please slow down, or upgrade for a higher limit.')); },
  });
}
