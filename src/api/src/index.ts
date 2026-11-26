import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadEnv } from './config/env.js';
import { assertAppRoleIsRestricted, createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createContainer } from './container.js';
import { createApp } from './http/app.js';
import { startScheduler } from './jobs/scheduler.js';
import { createShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' });

  if (env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    // Azure Monitor / Application Insights: requests, dependencies (pg, http) and exceptions.
    const appInsights = await import('applicationinsights');
    appInsights.default.setup(env.APPLICATIONINSIGHTS_CONNECTION_STRING).setSendLiveMetrics(true).start();
    logger.info('Application Insights enabled');
  }

  // Two pools: the owner pool only migrates and looks up the default tenant; everything else runs as the restricted role (row-level security).
  const ownerPool = createPool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, max: 2 });
  const applied = await migrate(ownerPool);
  if (applied.length) logger.info({ applied }, 'database migrations applied');
  const defaultTenant = (await ownerPool.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'default'")).rows[0]?.id;
  await ownerPool.end();
  const pool = createPool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, appRole: env.DB_APP_ROLE, ...(env.TENANT_FALLBACK === 'default' && defaultTenant ? { fallbackTenantId: defaultTenant } : {}) });
  await assertAppRoleIsRestricted(pool);

  const c = createContainer({ env, pool, logger });
  const admin = await c.auth.bootstrapAdmin(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
  if (admin) logger.warn({ email: admin.email }, 'bootstrap admin created: change this password after first login');
  if (c.images.isConfigured()) {
    // Best effort and non-blocking: storage being slow/unreachable must never delay startup or health probes.
    void c.images.ensureContainer().catch((err: unknown) => logger.warn({ err: String(err) }, 'could not ensure blob container'));
  }

  c.jobs.start({ concurrency: 4, pollMs: 1000 });
  const stopScheduler = startScheduler(pool, c.jobs, (err) => logger.warn({ err: String(err) }, 'maintenance scheduling failed'));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = path.resolve(here, '../../web/dist');
  const app = createApp(c, { staticDir });
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, channels: c.hub.status() }, 'StockSync API listening');
  });
  server.keepAliveTimeout = 65_000; // longer than the Azure load balancer idle timeout

  // Container Apps sends SIGTERM and waits terminationGracePeriodSeconds (30 s): stop taking requests, stop scheduling, drain jobs, close the pool.
  const shutdown = createShutdown([
    { name: 'http', run: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); }) },
    { name: 'scheduler', run: async () => { stopScheduler(); } },
    { name: 'jobs', run: () => c.jobs.stop() },
    { name: 'database', run: () => pool.end() },
  ], { timeoutMs: 25_000, exit: (code) => process.exit(code), log: (msg, data) => logger.info(data ?? {}, msg) });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
