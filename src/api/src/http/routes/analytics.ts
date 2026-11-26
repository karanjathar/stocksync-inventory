import { Router } from 'express';
import type { Container } from '../../container.js';
import { deadStockSchema, productSalesSchema, rangeSchema, resolveRange } from '../../services/analytics.js';
import { requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

/** Business analytics for staff and administrators (they include purchase costs and margins). Read-only, UTC calendar days, ranges up to 366 days. */
export function analyticsRoutes(c: Container): Router {
  const r = Router();
  r.use(requireRole('staff'));
  const range = (q: unknown) => resolveRange(parse(rangeSchema, q));
  r.get('/sales', async (req, res) => {
    const rg = range(req.query);
    const [byDay, byChannel] = await Promise.all([c.analytics.salesByDay(rg), c.analytics.salesByChannel(rg)]);
    res.json({ range: rg, ...byDay, byChannel });
  });
  r.get('/best-sellers', async (req, res) => {
    const q = parse(productSalesSchema, req.query);
    const rg = resolveRange(q);
    res.json({ range: rg, products: await c.analytics.salesByProduct(rg, q.limit) });
  });
  r.get('/dead-stock', async (req, res) => {
    const { days } = parse(deadStockSchema, req.query);
    res.json({ days, products: await c.analytics.deadStock(days) });
  });
  r.get('/margins', async (req, res) => {
    const q = parse(productSalesSchema, req.query);
    const rg = resolveRange(q);
    res.json({ range: rg, ...(await c.analytics.margins(rg, q.limit)) });
  });
  r.get('/funnel', async (req, res) => { const rg = range(req.query); res.json({ range: rg, ...(await c.analytics.funnel(rg)) }); });
  return r;
}
