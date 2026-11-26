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
import { PgBus } from './realtime/pgBus.js';
import { createWorkerApp } from './http/workerApp.js';

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
  const pool = createPool({ connectionString: env.DATABASE_APP_URL ?? env.DATABASE_URL, ssl: env.DATABASE_SSL, ...(env.DATABASE_APP_URL ? { scoped: true } : { appRole: env.DB_APP_ROLE }), ...(env.TENANT_FALLBACK === 'default' && defaultTenant ? { fallbackTenantId: defaultTenant } : {}) });
  await assertAppRoleIsRestricted(pool);
  const platformPool = createPool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, max: 3, appRole: env.DB_PLATFORM_ROLE });

  const c = createContainer({ env, pool, platformPool, logger });
  if (await c.platform?.bootstrapAdmin(env.PLATFORM_ADMIN_EMAIL, env.PLATFORM_ADMIN_PASSWORD)) logger.warn({ email: env.PLATFORM_ADMIN_EMAIL }, 'platform operator created: change this password after first login');
  const serveApi = env.PROCESS_ROLE !== 'worker';  // api or all
  const runWork = env.PROCESS_ROLE !== 'api';      // worker or all
  logger.info({ role: env.PROCESS_ROLE }, 'process role');
  const admin = serveApi ? await c.auth.bootstrapAdmin(env.ADMIN_EMAIL, env.ADMIN_PASSWORD) : undefined;
  if (admin) logger.warn({ email: admin.email }, 'bootstrap admin created: change this password after first login');
  if (c.images.isConfigured()) {
    // Best effort and non-blocking: storage being slow/unreachable must never delay startup or health probes.
    void c.images.ensureContainer().catch((err: unknown) => logger.warn({ err: String(err) }, 'could not ensure blob container'));
  }

  // Background work belongs to the worker process (or to the single process in 'all' mode).
  let stopScheduler = (): void => undefined;
  if (runWork) {
    c.jobs.start({ concurrency: 4, pollMs: 1000 });
    stopScheduler = startScheduler(pool, c.jobs, (err) => logger.warn({ err: String(err) }, 'maintenance scheduling failed'), 60_000, c.platform ? () => c.platform!.activeTenantIds() : undefined);

    // Businesses whose payment stayed unpaid past the grace period go back to Free.
    const billingTimer = c.billingWebhooks ? setInterval(() => { void c.billingWebhooks!.expireGrace().catch((err: unknown) => logger.warn({ err: String(err) }, 'grace expiry failed')); }, 10 * 60_000) : undefined;
    billingTimer?.unref();
    const eraseTimer = c.tenantEraser ? setInterval(() => { void c.tenantEraser!.runDue().catch((err: unknown) => logger.warn({ err: String(err) }, 'business erasure run failed')); }, 30 * 60_000) : undefined;
    eraseTimer?.unref();
  }

  // Several API replicas: events published on one reach the dashboards connected to the others (Postgres LISTEN/NOTIFY).
  const realtime = new PgBus({ connectionString: env.DATABASE_APP_URL ?? env.DATABASE_URL, ssl: env.DATABASE_SSL, pool, logger }, c.events);
  await realtime.start();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = path.resolve(here, '../../web/dist');
  const app = serveApi ? createApp(c, { staticDir }) : createWorkerApp(c); // a worker answers health probes only
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, role: env.PROCESS_ROLE }, 'StockSync listening');
  });
  server.keepAliveTimeout = 65_000; // longer than the Azure load balancer idle timeout

  // Container Apps sends SIGTERM and waits terminationGracePeriodSeconds (30 s): stop taking requests, stop scheduling, drain jobs, close the pool.
  const shutdown = createShutdown([
    { name: 'http', run: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); }) },
    { name: 'scheduler', run: async () => { stopScheduler(); } },
    { name: 'realtime', run: async () => { await realtime.stop(); } },
    { name: 'jobs', run: () => c.jobs.stop() },
    { name: 'database', run: async () => { await platformPool.end(); await pool.end(); } },
  ], { timeoutMs: 25_000, exit: (code) => process.exit(code), log: (msg, data) => logger.info(data ?? {}, msg) });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
