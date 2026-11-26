import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createContainer } from './container.js';
import { createApp } from './http/app.js';
import { startScheduler } from './jobs/scheduler.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' });

  if (env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    // Azure Monitor / Application Insights: requests, dependencies (pg, http) and exceptions.
    const appInsights = await import('applicationinsights');
    appInsights.default.setup(env.APPLICATIONINSIGHTS_CONNECTION_STRING).setSendLiveMetrics(true).start();
    logger.info('Application Insights enabled');
  }

  const pool = createPool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL });
  const applied = await migrate(pool);
  if (applied.length) logger.info({ applied }, 'database migrations applied');

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

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      stopScheduler();
      c.jobs.stop().finally(() => pool.end().finally(() => process.exit(0)));
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
