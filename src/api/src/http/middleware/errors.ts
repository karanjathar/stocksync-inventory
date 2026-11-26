import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { AppError } from '../../domain/errors.js';

interface PgLikeError { code?: string; detail?: string }

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as PgLikeError).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

export function errorHandler(logger?: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof AppError) {
      const wait = (err.details as { retryAfterSec?: unknown } | undefined)?.retryAfterSec;
      if (err.status === 429 && typeof wait === 'number') res.set('Retry-After', String(wait));
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    // http-errors from body-parser (malformed JSON, payload too large) and serve-static (missing file)
    if (typeof err === 'object' && err !== null && 'status' in err) {
      const status = Number((err as { status: unknown }).status);
      if (status === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
        return;
      }
      if (status >= 400 && status < 500) {
        res.status(status).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request' } });
        return;
      }
    }
    switch (pgCode(err)) {
      case '23505':
        res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these unique values already exists' } });
        return;
      case '22021': // NUL (0x00) or another byte sequence Postgres text cannot hold
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Text contains a character that is not allowed' } });
        return;
      case '23503':
        res.status(409).json({ error: { code: 'CONFLICT', message: 'Referenced record does not exist or is still in use' } });
        return;
      case '23502':
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'A required value is missing' } });
        return;
      case '22P02':
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed identifier' } });
        return;
      case '23514':
        res.status(409).json({ error: { code: 'CONFLICT', message: 'Operation violates a data constraint' } });
        return;
    }
    logger?.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  };
}
