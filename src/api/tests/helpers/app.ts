import type pg from 'pg';
import type { Express } from 'express';
import request from 'supertest';
import { freshDb, TEST_DATABASE_URL } from './db.js';
import { createPool } from '../../src/db/pool.js';
import { createApp } from '../../src/http/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createContainer, type Container, type ContainerOverrides } from '../../src/container.js';
import type { Role } from '../../src/domain/types.js';

export interface TestApp {
  app: Express;
  pool: pg.Pool;
  c: Container;
  env: Env;
  /** The platform role's pool (no access to business data). */
  platformPool: pg.Pool;
  /** Returns a bearer token for a freshly created user with the given role. */
  token(role: Role): Promise<string>;
  close(): Promise<void>;
}

export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'test-secret-'.padEnd(40, 'x'),
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'AdminPass123!',
  META_APP_SECRET: 'meta-secret',
  META_VERIFY_TOKEN: 'verify-me',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
};

export async function buildTestApp(envOverrides: Record<string, string> = {}, overrides: ContainerOverrides = {}): Promise<TestApp> {
  const pool = await freshDb();
  const env = loadEnv({ ...TEST_ENV, ...envOverrides });
  const platformPool = createPool({ connectionString: TEST_DATABASE_URL, ssl: false, appRole: 'stocksync_platform' });
  const c = createContainer({ env, pool, platformPool, ...overrides });
  await c.auth.bootstrapAdmin(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
  await c.platform?.bootstrapAdmin(env.PLATFORM_ADMIN_EMAIL, env.PLATFORM_ADMIN_PASSWORD);
  const app = createApp(c);
  let n = 0;
  const tokens = new Map<Role, string>();
  return {
    app, pool, c, env, platformPool,
    async token(role) {
      const cached = tokens.get(role);
      if (cached) return cached;
      const email = `${role}${++n}@test.local`;
      await c.auth.createUser({ email, password: 'Password123!', name: `${role} user`, role });
      const res = await request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
      const token = res.body.token as string;
      tokens.set(role, token);
      return token;
    },
    close: async () => { await platformPool.end(); await pool.end(); },
  };
}
