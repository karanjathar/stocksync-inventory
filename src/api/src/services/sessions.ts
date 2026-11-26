import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { currentTenantId } from '../db/tenant.js';
import { UnauthorizedError } from '../domain/errors.js';

export const REFRESH_TTL_DAYS = 30;
export const ACCESS_TTL = '15m';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Rotated { tenantId: string; userId: string; familyId: string; refresh: string }

/**
 * Browser sessions: a short access cookie plus a long refresh cookie whose tokens are single use. Every use mints the next token in the same
 * family; presenting an already-used token means two parties hold it, so the whole family is revoked. A token is `<tenant id>.<random>`:
 * the tenant id only tells us which business's rows to look in (row-level security), the secret part does the authenticating.
 * All methods except `rotate` must run inside the business's context.
 */
export class SessionService {
  constructor(private readonly db: Queryable, private readonly secret: string, private readonly runAs: <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>) {}

  private mint(tenantId: string): { token: string; hash: string } {
    const token = `${tenantId}.${randomBytes(32).toString('base64url')}`;
    return { token, hash: sha256(token) };
  }

  /** A brand-new family for this login. Never reuses anything the browser sent (no session fixation). */
  async start(userId: string): Promise<{ familyId: string; refresh: string }> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new UnauthorizedError();
    const m = this.mint(tenantId);
    const familyId = (await this.db.query<{ f: string }>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, gen_random_uuid(), $2, now() + make_interval(days => $3)) RETURNING family_id AS f`,
      [userId, m.hash, REFRESH_TTL_DAYS])).rows[0]!.f;
    return { familyId, refresh: m.token };
  }

  /** Exchanges a refresh token for the next one. Unknown, expired, revoked or REUSED tokens are all a plain 401; a reused one also kills its family. */
  async rotate(presented: string): Promise<Rotated> {
    const tenantId = presented.split('.', 1)[0] ?? '';
    if (!UUID.test(tenantId) || presented.length > 200) throw new UnauthorizedError('Session expired');
    return this.runAs(tenantId, async () => {
      const row = (await this.db.query<{ id: string; userId: string; familyId: string; used: boolean; revoked: boolean; expired: boolean }>(
        `SELECT id, user_id AS "userId", family_id AS "familyId", used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked, expires_at <= now() AS expired
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [sha256(presented)])).rows[0];
      if (!row || row.revoked || row.expired) throw new UnauthorizedError('Session expired');
      if (row.used) { await this.revokeFamily(row.familyId); throw new UnauthorizedError('Session expired'); } // replay: someone else has a copy
      const next = this.mint(tenantId);
      await this.db.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [row.id]);
      await this.db.query(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, (SELECT expires_at FROM refresh_tokens WHERE id = $4))`,
        [row.userId, row.familyId, next.hash, row.id]); // the family keeps its original end date: a session cannot be extended forever by refreshing
      return { tenantId, userId: row.userId, familyId: row.familyId, refresh: next.token };
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [familyId]);
  }

  /** Ends every session of a user: all refresh families, and every access or bearer token issued before now. */
  async revokeAll(userId: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await this.db.query('UPDATE users SET sessions_valid_after = $2 WHERE id = $1', [userId, new Date()]); // app clock: the same one that stamps each token's `at`
  }

  async isFamilyActive(familyId: string): Promise<boolean> {
    return ((await this.db.query('SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1', [familyId])).rowCount ?? 0) === 0;
  }

  /** CSRF token bound to one session: `<random>.<hmac(random, session)>`. A token copied from another session, or planted from a sibling domain, fails. */
  csrfFor(familyId: string): string {
    const r = randomBytes(16).toString('base64url');
    return `${r}.${this.mac(r, familyId)}`;
  }

  verifyCsrf(token: string | undefined, familyId: string): boolean {
    if (!token || token.length > 200) return false;
    const [r, mac] = token.split('.');
    if (!r || !mac) return false;
    const want = Buffer.from(this.mac(r, familyId)); const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private mac(random: string, familyId: string): string {
    return createHmac('sha256', `${this.secret}:csrf`).update(`${random}.${familyId}`).digest('base64url');
  }
}
