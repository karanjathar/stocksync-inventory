import express, { Router, type Express } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { Container } from '../container.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { requireAuth } from './middleware/auth.js';
import { requestLog } from './middleware/requestLog.js';
import { authRoutes } from './routes/auth.js';
import { signupRoutes } from './routes/signup.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { usageRoutes } from './routes/plans.js';
import { billingRoutes } from './routes/billing.js';
import { auditRoutes } from './routes/audit.js';
import { dataRightsRoutes } from './routes/dataRights.js';
import { auditTrail } from './middleware/audit.js';
import { tenantRateLimit } from './middleware/rateLimit.js';
import { userRoutes } from './routes/users.js';
import { stockRoutes } from './routes/stock.js';
import { settingsRoutes } from './routes/settings.js';
import { sseHandler } from '../realtime/sse.js';
import { orderRoutes } from './routes/orders.js';
import { dashboardStats } from '../services/dashboard.js';
import { webhookRoutes } from './routes/webhooks.js';
import { channelRoutes, messageRoutes } from './routes/messages.js';
import { publicRoutes, uploadRoutes } from './routes/public.js';
import { paymentRoutes } from './routes/payments.js';
import { opsRoutes } from './routes/ops.js';
import { channelConfigRoutes } from './routes/channelConfig.js';
import { platformRoutes } from './routes/platform.js';
import { stockCountRoutes } from './routes/stockCounts.js';
import { purchaseOrderRoutes, reorderRoutes } from './routes/purchaseOrders.js';
import { pendingMigrations } from '../db/migrate.js';
import { categoryRoutes, customerRoutes, productRoutes, supplierRoutes, warehouseRoutes } from './routes/catalog.js';

export interface AppOptions {
  /** Directory of the built web SPA (src/web/dist). Served with an index.html fallback. */
  staticDir?: string;
}

export function createApp(c: Container, opts: AppOptions = {}): Express {
  const { env, pool, logger } = c;
  const app = express();
  app.disable('x-powered-by');
  const blobOrigin = c.images.origin();
  app.set('trust proxy', 1); // Azure Container Apps ingress
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:', ...(blobOrigin ? [blobOrigin] : [])],
          connectSrc: ["'self'", 'https://*.blob.core.windows.net', ...(blobOrigin ? [blobOrigin] : [])],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
    }),
  );
  app.use(requestLog(logger));
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: false }));
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  // Readiness: should this replica receive traffic? Never leaks error details.
  app.get('/readyz', async (_req, res) => {
    const checks = { db: false, migrations: false, worker: false };
    try {
      await pool.query('SELECT 1');
      checks.db = true;
      checks.migrations = (await pendingMigrations(pool)).length === 0;
      // Any worker will do: with separate api and worker processes the heartbeat comes from another container.
      const hb = await pool.query("SELECT 1 FROM worker_heartbeats WHERE seen_at > now() - interval '60 seconds' LIMIT 1");
      checks.worker = (hb.rowCount ?? 0) > 0;
    } catch { /* a failed check stays false */ }
    const ready = checks.db && checks.migrations && checks.worker;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
  });

  const api = Router();
  api.use(rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 10_000 : 600, standardHeaders: true, legacyHeaders: false }));
  api.use('/auth', authRoutes(c));
  api.use('/signup', signupRoutes(c));
  api.use('/public', publicRoutes(c));
  api.use('/platform', platformRoutes(c));

  // Each group below requires a valid token.
  const secure = [requireAuth(c.auth, c.sessions), tenantRateLimit(c), auditTrail(c)];
  api.use('/users', secure, userRoutes(c));
  api.use('/categories', secure, categoryRoutes(c));
  api.use('/products', secure, productRoutes(c));
  api.use('/warehouses', secure, warehouseRoutes(c));
  api.use('/stock', secure, stockRoutes(c));
  api.use('/suppliers', secure, supplierRoutes(c));
  api.use('/customers', secure, customerRoutes(c));
  api.use('/settings', secure, settingsRoutes(c));
  api.get('/events', secure, sseHandler(c.events));
  api.use('/orders', secure, orderRoutes(c));
  api.use('/messages', secure, messageRoutes(c));
  api.use('/channels', secure, channelRoutes(c));
  api.use('/uploads', secure, uploadRoutes(c));
  api.use('/payments', secure, paymentRoutes(c));
  api.use('/ops', secure, opsRoutes(c));
  api.use('/onboarding', secure, onboardingRoutes(c));
  api.use('/usage', secure, usageRoutes(c));
  api.use('/billing', secure, billingRoutes(c));
  api.use('/audit-log', secure, auditRoutes(c));
  api.use('/data', secure, dataRightsRoutes(c));
  api.use('/channel-config', secure, channelConfigRoutes(c));
  api.use('/purchase-orders', secure, purchaseOrderRoutes(c));
  api.use('/reorder-suggestions', secure, reorderRoutes(c));
  api.use('/stock-counts', secure, stockCountRoutes(c));
  api.get('/dashboard', ...secure, async (_req, res) => { res.json(await dashboardStats(pool)); });

  app.use('/api', api);
  app.use('/api', notFoundHandler);
  app.use('/webhooks', webhookRoutes(c));
  app.use('/webhooks', notFoundHandler);

  if (opts.staticDir && existsSync(path.join(opts.staticDir, 'index.html'))) {
    const indexFile = path.join(opts.staticDir, 'index.html');
    app.use('/assets', express.static(path.join(opts.staticDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    // Client-side routing: unknown GETs render the SPA shell.
    app.get('/{*splat}', (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(indexFile);
    });
  }
  app.use(errorHandler(logger));
  return app;
}
