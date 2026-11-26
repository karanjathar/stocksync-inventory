import { createHash } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { AppError } from '../domain/errors.js';

export class TooManyAttemptsError extends AppError {
  constructor(readonly retryAfterSec: number) {
    super(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Please wait a little and try again.', { retryAfterSec });
  }
}

const WINDOW_MINUTES = 15;      // failures older than this no longer count
const MAX_LOCK_SEC = 900;
const BASE_LOCK_SEC = 30;
const ACCOUNT_THRESHOLD = 5;    // per account, wherever the attempts come from
const IP_THRESHOLD = 20;        // per client address: higher, because many people can share one (an office, a mobile carrier)

/**
 * Lockout with exponential backoff, per account and per client address. Keys are hashes of what was TYPED, so an email that has no account is
 * locked exactly like one that has (nothing about the answer reveals which exist), and the check happens before the password is looked at, so a
 * correct password does not get through while locked. The first lock is 30 s, doubling to 15 min.
 */
export class LoginGuard {
  constructor(private readonly db: Queryable, private readonly scope = 'login') {}

  private keys(identity: string, ip: string | undefined): { acct: string; ip?: string } {
    const acct = `${this.scope}:acct:${createHash('sha256').update(identity.trim().toLowerCase()).digest('hex')}`;
    return ip ? { acct, ip: `${this.scope}:ip:${ip}` } : { acct };
  }

  /** Throws TooManyAttemptsError while either the account or the address is locked. */
  async check(identity: string, ip?: string): Promise<void> {
    const k = this.keys(identity, ip);
    const { rows } = await this.db.query<{ wait: number | null }>(
      'SELECT ceil(extract(epoch FROM max(locked_until) - now()))::int AS wait FROM login_attempts WHERE key = ANY($1) AND locked_until > now()', [Object.values(k)]);
    const wait = rows[0]?.wait;
    if (wait && wait > 0) throw new TooManyAttemptsError(wait);
  }

  async failure(identity: string, ip?: string): Promise<void> {
    const k = this.keys(identity, ip);
    await this.bump(k.acct, ACCOUNT_THRESHOLD);
    if (k.ip) await this.bump(k.ip, IP_THRESHOLD);
  }

  /** A good sign-in clears that account's counter (not the address's: one success must not wipe the evidence about a guessing client). */
  async success(identity: string): Promise<void> {
    await this.db.query('DELETE FROM login_attempts WHERE key = $1', [this.keys(identity, undefined).acct]);
  }

  private async bump(key: string, threshold: number): Promise<void> {
    const n = `(CASE WHEN login_attempts.last_failure_at < now() - make_interval(mins => $3) THEN 1 ELSE login_attempts.failures + 1 END)`;
    await this.db.query(
      `INSERT INTO login_attempts (key, failures, last_failure_at, locked_until)
       VALUES ($1, 1, now(), CASE WHEN 1 >= $2 THEN now() + make_interval(secs => $4) END)
       ON CONFLICT (key) DO UPDATE SET failures = ${n}, last_failure_at = now(),
         locked_until = CASE WHEN ${n} >= $2 THEN now() + make_interval(secs => least($5::int, $4::int * power(2, ${n} - $2)::int)) END`,
      [key, threshold, WINDOW_MINUTES, BASE_LOCK_SEC, MAX_LOCK_SEC]);
  }
}
