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

describe('provider base URLs must be https in production (T56)', () => {
  const prod = { ...base, NODE_ENV: 'production' };

  it.each(['RAZORPAY_API_BASE', 'META_GRAPH_BASE'])('%s: plain http to a remote host is refused in production, with a clear message', (name) => {
    expect(() => loadEnv({ ...prod, [name]: 'http://payments.evil.example' })).toThrow(new RegExp(`${name}.*https`, 'i'));
    expect(() => loadEnv({ ...prod, [name]: 'http://203.0.113.9:8080/api' })).toThrow(/https/);
    expect(() => loadEnv({ ...prod, [name]: 'ftp://example.com' })).toThrow(/https/);
  });

  it.each(['RAZORPAY_API_BASE', 'META_GRAPH_BASE'])('%s: https and loopback (local E2E fakes) are accepted in production', (name) => {
    for (const ok of ['https://api.razorpay.com', 'https://proxy.internal.example:8443/base', 'http://127.0.0.1:9999', 'http://localhost:3000', 'http://[::1]:4000']) {
      expect(() => loadEnv({ ...prod, [name]: ok })).not.toThrow();
    }
    expect(() => loadEnv(prod)).not.toThrow(); // the defaults are https
  });

  it('is not enforced outside production (development and tests may use plain http fakes)', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => loadEnv({ ...base, NODE_ENV, RAZORPAY_API_BASE: 'http://fake.example', META_GRAPH_BASE: 'http://fake.example' })).not.toThrow();
    }
  });

  it('reports every offending variable at once', () => {
    expect(() => loadEnv({ ...prod, RAZORPAY_API_BASE: 'http://a.example', META_GRAPH_BASE: 'http://b.example' })).toThrow(/RAZORPAY_API_BASE[\s\S]*META_GRAPH_BASE/);
  });

  describe('default admin password guard', () => {
    const prod = { ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://shop.example.com' };
    it('refuses the well-known default password on a public https deployment', () => {
      expect(() => loadEnv({ ...prod, ADMIN_PASSWORD: 'ChangeMe123!' })).toThrow(/ADMIN_PASSWORD/);
    });
    it('refuses very short admin passwords on a public https deployment', () => {
      expect(() => loadEnv({ ...prod, ADMIN_PASSWORD: 'short1' })).toThrow(/ADMIN_PASSWORD/);
    });
    it('accepts a strong password, and the local quick start (http localhost) keeps its default', () => {
      expect(loadEnv({ ...prod, ADMIN_PASSWORD: 'a-long-unique-passphrase-9' }).ADMIN_PASSWORD).toBeDefined();
      expect(loadEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://localhost:3005', ADMIN_PASSWORD: 'ChangeMe123!' })).toBeDefined();
    });
  });
});
