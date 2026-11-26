import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import { currentTenantId, DEFAULT_TENANT_ID } from '../db/tenant.js';
import { NotConfiguredError } from '../domain/errors.js';
import type { SecretBox } from './secrets.js';

const text = (max = 512) => z.string().trim().min(1).max(max);
/** One schema per kind. Secrets are write-only: they are validated here, encrypted, and never sent back to a browser. */
export const CREDENTIAL_SCHEMAS = {
  meta: z.object({ appSecret: text(128), verifyToken: text(128) }),
  whatsapp: z.object({ token: text(1024), phoneNumberId: z.string().trim().regex(/^[0-9]{3,32}$/, 'digits only') }),
  messenger: z.object({ pageToken: text(1024) }),
  instagram: z.object({ pageToken: text(1024) }),
  telegram: z.object({ botToken: text(256), webhookSecret: z.string().trim().regex(/^[A-Za-z0-9_-]{1,256}$/, 'letters, digits, _ and - only') }),
  razorpay: z.object({ keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'must look like rzp_test_… or rzp_live_…'), keySecret: text(128), webhookSecret: text(128) }),
} as const;
export type CredentialKind = keyof typeof CREDENTIAL_SCHEMAS;
export type Credentials<K extends CredentialKind> = z.infer<(typeof CREDENTIAL_SCHEMAS)[K]>;
export const CREDENTIAL_KINDS = Object.keys(CREDENTIAL_SCHEMAS) as CredentialKind[];
/** The one field whose last four characters identify a saved credential in the UI. */
const HINT_FIELD: Record<CredentialKind, string> = { meta: 'appSecret', whatsapp: 'token', messenger: 'pageToken', instagram: 'pageToken', telegram: 'botToken', razorpay: 'keyId' };

export interface EnvCredentials { [k: string]: unknown }
const TTL_MS = 30_000;

/**
 * Per-business credentials. A business uses what it saved; the server's own environment keys apply ONLY to the original default business
 * (single-business installs), never to any other business. Reads are cached for 30 s per business and kind.
 */
export class ChannelCredentials {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly box: SecretBox | undefined,
    private readonly envDefaults: Partial<Record<CredentialKind, Record<string, string>>>,
    private readonly fallbackIsDefault: boolean,
    private readonly logger?: Logger,
  ) {}

  private tenant(): string | undefined {
    return currentTenantId() ?? (this.fallbackIsDefault ? DEFAULT_TENANT_ID : undefined);
  }

  get enabled(): boolean { return this.box !== undefined; }

  /** Forgets cached values (they expire on their own after 30 s; this is for tests and key rotation). */
  clearCache(): void { this.cache.clear(); }

  /** The credentials of this kind for the current business, or undefined. An unreadable (tampered or foreign) value counts as not configured. */
  async get<K extends CredentialKind>(kind: K): Promise<Partial<Credentials<K>> | undefined> {
    const tenant = this.tenant();
    if (!tenant) return undefined;
    const key = `${tenant}:${kind}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Partial<Credentials<K>> | undefined;
    let value: Partial<Credentials<K>> | undefined;
    if (this.box) {
      const { rows } = await this.pool.query<{ config_encrypted: Buffer }>('SELECT config_encrypted FROM tenant_channels WHERE kind = $1', [kind]);
      if (rows[0]) {
        try { value = CREDENTIAL_SCHEMAS[kind].parse(JSON.parse(this.box.decrypt(rows[0].config_encrypted, tenant))) as Credentials<K>; }
        catch (err) { this.logger?.error({ kind, tenant, err: String(err) }, 'stored channel credentials could not be read; treating as not configured'); }
      }
    }
    if (!value && tenant === DEFAULT_TENANT_ID && this.fallbackIsDefault) {
      // The server's own environment values keep their original, independent semantics (each one may be set without the others).
      const env = this.envDefaults[kind];
      if (env && Object.keys(env).length) value = env as Partial<Credentials<K>>;
    }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async set<K extends CredentialKind>(kind: K, input: unknown): Promise<void> {
    if (!this.box) throw new NotConfiguredError('Credential storage (ENCRYPTION_KEY)');
    const tenant = currentTenantId();
    if (!tenant) throw new Error('no tenant context');
    const config = CREDENTIAL_SCHEMAS[kind].parse(input);
    await this.pool.query(
      `INSERT INTO tenant_channels (kind, config_encrypted, key_version) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, kind) DO UPDATE SET config_encrypted = EXCLUDED.config_encrypted, key_version = EXCLUDED.key_version, updated_at = now()`,
      [kind, this.box.encrypt(JSON.stringify(config), tenant), this.box.version]);
    this.cache.delete(`${tenant}:${kind}`);
  }

  async remove(kind: CredentialKind): Promise<void> {
    const tenant = currentTenantId();
    await this.pool.query('DELETE FROM tenant_channels WHERE kind = $1', [kind]);
    if (tenant) this.cache.delete(`${tenant}:${kind}`);
  }

  /** What the settings screen may show: which kinds are set and the last four characters of one identifying field. Never a secret. */
  async summary(): Promise<{ kind: CredentialKind; configured: boolean; hint: string | null; source: 'saved' | 'server' | null }[]> {
    const tenant = this.tenant();
    const saved = new Set<string>();
    if (this.box) for (const r of (await this.pool.query<{ kind: string }>('SELECT kind FROM tenant_channels')).rows) saved.add(r.kind);
    const out = [];
    for (const kind of CREDENTIAL_KINDS) {
      const value = (await this.get(kind)) as Record<string, string | undefined> | undefined;
      const field = value?.[HINT_FIELD[kind]];
      out.push({ kind, configured: value !== undefined, hint: field ? field.slice(-4) : null, source: value ? (saved.has(kind) ? 'saved' as const : (tenant === DEFAULT_TENANT_ID ? 'server' as const : null)) : null });
    }
    return out;
  }
}
