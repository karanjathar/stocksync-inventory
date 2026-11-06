import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('parses a minimal valid environment with defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.META_GRAPH_VERSION).toBe('v21.0');
    expect(env.META_GRAPH_BASE).toBe('https://graph.facebook.com');
    expect(env.DATABASE_SSL).toBe(false);
  });

  it('splits CORS origins and coerces booleans and numbers', () => {
    const env = loadEnv({ ...base, PORT: '3000', CORS_ORIGINS: 'http://a.com, http://b.com', DATABASE_SSL: 'true' });
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGINS).toEqual(['http://a.com', 'http://b.com']);
    expect(env.DATABASE_SSL).toBe(true);
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('treats empty strings as unset', () => {
    const env = loadEnv({ ...base, WHATSAPP_TOKEN: '', AZURE_STORAGE_CONNECTION_STRING: '' });
    expect(env.WHATSAPP_TOKEN).toBeUndefined();
    expect(env.AZURE_STORAGE_CONNECTION_STRING).toBeUndefined();
  });
});
