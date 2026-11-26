import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  DATABASE_URL: z
    .string()
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// connection string'),
  DATABASE_SSL: bool,
  /** Restricted role the app serves requests as, so row-level security applies (D-018). The connecting user must be allowed to SET ROLE to it. */
  /** Stronger setup: connect AS the restricted login role (no SET ROLE, so injected SQL cannot RESET ROLE back to the owner). Migrations still use DATABASE_URL. */
  DATABASE_APP_URL: z.string().url().optional(),
  DB_APP_ROLE: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('stocksync_app'),
  /** `default`: requests, jobs and webhooks without a tenant context run as the default tenant (single-business mode, until T94/T95). `off`: strict. */
  /** Restricted role for the platform console (manages businesses, reads no business data). */
  DB_PLATFORM_ROLE: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('stocksync_platform'),
  /** First platform operator, created on startup when no platform admin exists. */
  PLATFORM_ADMIN_EMAIL: z.string().email().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().min(12).optional(),
  /** AES-256 key (base64, 32 bytes) for per-business channel credentials: `openssl rand -base64 32`. Without it, businesses cannot save their own credentials. */
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded').optional(),
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(255).default(1),
  /** Old key kept readable while credentials are re-encrypted after a rotation: "<version>:<base64>". */
  ENCRYPTION_KEY_PREVIOUS: z.string().regex(/^[0-9]{1,3}:[A-Za-z0-9+/=]+$/).optional(),
  TENANT_FALLBACK: z.enum(['default', 'off']).default('default'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  ADMIN_EMAIL: optional,
  ADMIN_PASSWORD: optional,
  AZURE_STORAGE_CONNECTION_STRING: optional,
  AZURE_STORAGE_CONTAINER: z.string().default('product-images'),
  APPLICATIONINSIGHTS_CONNECTION_STRING: optional,
  META_APP_SECRET: optional,
  META_VERIFY_TOKEN: optional,
  META_GRAPH_VERSION: z.string().default('v21.0'),
  // Only overridden by tests / the E2E fake Meta API.
  META_GRAPH_BASE: z.string().url().default('https://graph.facebook.com'),
  WHATSAPP_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  MESSENGER_PAGE_TOKEN: optional,
  INSTAGRAM_PAGE_TOKEN: optional,
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_WEBHOOK_SECRET: optional,
  RAZORPAY_KEY_ID: optional,
  RAZORPAY_KEY_SECRET: optional,
  RAZORPAY_WEBHOOK_SECRET: optional,
  // Only overridden by tests / the E2E fake Razorpay.
  RAZORPAY_API_BASE: z.string().url().default('https://api.razorpay.com'),
})
  // Credentials travel to these hosts in the Authorization header: never over plain http in production.
  // (Loopback is allowed so the local E2E can point the app at its fake providers.)
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // A public (https) deployment must not boot with the documented default or a trivially short admin password.
    // The local docker-compose quick start (http://localhost) keeps its convenient default.
    if (env.ADMIN_PASSWORD && new URL(env.PUBLIC_BASE_URL).protocol === 'https:') {
      if (env.ADMIN_PASSWORD === 'ChangeMe123!' || env.ADMIN_PASSWORD.length < 12) {
        ctx.addIssue({ code: 'custom', path: ['ADMIN_PASSWORD'], message: 'must be a unique password of at least 12 characters on a public deployment' });
      }
    }
    for (const key of ['RAZORPAY_API_BASE', 'META_GRAPH_BASE'] as const) {
      const url = new URL(env[key]);
      const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must use https in production (plain http is only allowed for localhost)' });
      }
    }
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}
