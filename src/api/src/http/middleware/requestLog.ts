import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

/** One structured line per request. Logs the path only (no query string, headers or bodies) so tokens and PII never reach logs. */
export function requestLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      if (path === '/healthz') return;
      const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]({ method: req.method, path, status: res.statusCode, ms, user: req.user?.id, tenantId: req.user?.tenantId }, 'request');
    });
    next();
  };
}
