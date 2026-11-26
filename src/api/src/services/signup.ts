import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { Queryable } from '../db/pool.js';
import { ConflictError, ValidationError } from '../domain/errors.js';
import { SLUG_RE } from '../repositories/tenants.js';
import type { EmailSender } from './email.js';

/** Names that would collide with routes, infrastructure or impersonation. */
export const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'administrator', 'root', 'shop', 'shops', 'platform', 'default', 'support', 'help', 'billing', 'static', 'assets',
  'login', 'logout', 'signup', 'signin', 'register', 'verify', 'health', 'healthz', 'readyz', 'status', 'mail', 'email', 'webhooks', 'public', 'stocksync', 'test', 'demo', 'null', 'undefined']);

const TOKEN_TTL_MS = 24 * 3600_000;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 4);
export interface SignupInput { email: string; password: string; businessName: string; ownerName: string; slug: string }

/**
 * Self-service sign-up. The business exists only after the owner opens the emailed link. Every outcome that could reveal whether an email address
 * already has an account (new, already registered, throttled) looks identical to the caller; the work that differs happens in the background.
 */
export class SignupService {
  constructor(private readonly db: Queryable, private readonly email: EmailSender, private readonly baseUrl: string, private readonly logger: Logger,
    private readonly rounds = 12, private readonly minIntervalSec = 60, private readonly maxSends = 5) {}

  private link(token: string): string { return `${this.baseUrl.replace(/\/+$/, '')}/verify-email?token=${token}`; }
  private background(work: Promise<void>): void { work.catch((err: unknown) => this.logger.error({ err: String(err) }, 'signup email failed')); }
  private newToken() { const token = randomBytes(32).toString('base64url'); return { token, hash: sha256(token), expires: new Date(Date.now() + TOKEN_TTL_MS) }; }

  static checkSlug(slug: string): void {
    if (!SLUG_RE.test(slug)) throw new ValidationError('Invalid request', [{ path: 'slug', message: '3–40 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen' }]);
    if (slug.includes('--') || RESERVED_SLUGS.has(slug)) throw new ValidationError('Invalid request', [{ path: 'slug', message: 'This web address is not available' }]);
  }

  async start(input: SignupInput): Promise<void> {
    const email = input.email.trim().toLowerCase();
    SignupService.checkSlug(input.slug);
    const hash = await bcrypt.hash(input.password, this.rounds); // always done, so timing does not depend on the account existing
    const t = this.newToken();
    const result = (await this.db.query<{ r: string }>('SELECT signup_begin($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r',
      [email, input.slug, input.businessName.trim(), input.ownerName.trim(), hash, t.hash, t.expires, this.minIntervalSec, this.maxSends])).rows[0]?.r;
    if (result === 'slug_taken') throw new ConflictError('This web address is already taken');
    if (result === 'sent') {
      this.background(this.email.send({ to: email, subject: 'Confirm your StockSync account',
        text: `Welcome to StockSync, ${input.ownerName.trim()}.\n\nConfirm your email address to open ${input.businessName.trim()}:\n${this.link(t.token)}\n\nThe link works once and expires in 24 hours. If you did not sign up, ignore this message.` }));
    } else if (result === 'email_registered') {
      this.background(this.email.send({ to: email, subject: 'You already have a StockSync account',
        text: `Someone (hopefully you) tried to sign up with this address, but an account already exists. Sign in instead: ${this.baseUrl.replace(/\/+$/, '')}/login\n\nIf you did not do this, no action is needed.` }));
    }
  }

  async resend(emailInput: string): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    await bcrypt.compare('x', DUMMY_HASH); // keeps the cost the same whether or not a request exists
    const t = this.newToken();
    const result = (await this.db.query<{ r: string }>('SELECT signup_resend($1, $2, $3, $4, $5) AS r', [email, t.hash, t.expires, this.minIntervalSec, this.maxSends])).rows[0]?.r;
    if (result === 'sent') {
      this.background(this.email.send({ to: email, subject: 'Confirm your StockSync account', text: `Confirm your email address:\n${this.link(t.token)}\n\nThe link works once and expires in 24 hours.` }));
    }
  }

  /** Creates the business. Undefined for an unknown, used or expired link (all the same answer). */
  async verify(token: string): Promise<{ slug: string } | undefined> {
    const row = (await this.db.query<{ slug: string }>('SELECT slug FROM signup_complete($1)', [sha256(token)])).rows[0];
    return row ? { slug: row.slug } : undefined;
  }
}
