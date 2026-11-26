import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../domain/errors.js';
import type { AuthUser, Role, User } from '../domain/types.js';
import type { UsersRepo } from '../repositories/users.js';
import type { TenantsRepo } from '../repositories/tenants.js';

const BCRYPT_ROUNDS = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Constant-time-ish path for unknown emails so timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 4);

export interface NewUser { email: string; password: string; name: string; role: Role }

export class AuthService {
  constructor(
    private readonly users: UsersRepo,
    private readonly secret: string,
    private readonly expiresIn: string,
    private readonly rounds: number = BCRYPT_ROUNDS,
    private readonly tenants?: TenantsRepo,
  ) {}

  async createUser(input: NewUser): Promise<User> {
    const email = input.email.trim().toLowerCase();
    if (await this.users.findByEmailWithHash(email)) throw new ConflictError('Email is already registered');
    const passwordHash = await bcrypt.hash(input.password, this.rounds);
    return this.users.create({ email, passwordHash, name: input.name.trim(), role: input.role });
  }

  async updateUser(id: string, patch: { name?: string; role?: Role; password?: string }): Promise<User> {
    const passwordHash = patch.password ? await bcrypt.hash(patch.password, this.rounds) : undefined;
    const user = await this.users.update(id, { name: patch.name, role: patch.role, passwordHash });
    if (!user) throw new NotFoundError('User');
    return user;
  }

  async changePassword(email: string, currentPassword: string, newPassword: string): Promise<void> {
    const found = await this.users.findByEmailWithHash(email);
    if (!found || !(await bcrypt.compare(currentPassword, found.passwordHash))) throw new UnauthorizedError('Current password is incorrect');
    await this.users.update(found.id, { passwordHash: await bcrypt.hash(newPassword, this.rounds) });
  }

  async bootstrapAdmin(email: string | undefined, password: string | undefined): Promise<User | undefined> {
    if (!email || !password) return undefined;
    if ((await this.users.count()) > 0) return undefined;
    return this.createUser({ email, password, name: 'Administrator', role: 'admin' });
  }

  async login(email: string, password: string): Promise<{ token: string; user: User; tenantId: string }> {
    const found = await this.users.findForLogin(email.trim().toLowerCase());
    const ok = await bcrypt.compare(password, found?.passwordHash ?? DUMMY_HASH);
    if (!found || !ok) throw new UnauthorizedError('Invalid email or password');
    // Only after the password is right, so a wrong guess never reveals that an account exists or is suspended.
    if (found.tenantStatus !== 'ACTIVE') throw new ForbiddenError('This business account is suspended. Please contact support.');
    const { passwordHash: _omit, tenantId, tenantStatus: _status, ...user } = found;
    return { token: this.sign(user, tenantId, this.expiresIn), user, tenantId };
  }

  /** A signed token. `sid` ties a browser access token to its session family (so ending the session ends the token); `at` lets "log out everywhere" void older tokens. */
  sign(user: { id: string; email: string; role: Role }, tenantId: string, expiresIn: string, sid?: string): string {
    return jwt.sign({ typ: 'tenant', tid: tenantId, email: user.email, role: user.role, at: Date.now(), ...(sid ? { sid } : {}) }, this.secret, {
      subject: user.id, expiresIn: expiresIn as SignOptions['expiresIn'], algorithm: 'HS256',
    });
  }

  /** Checks signature, type and tenant claim only (no database). Business tokens are `typ: tenant` with a tenant id; anything else is refused. */
  verify(token: string): { sub: string; tid: string; sid?: string; at?: number } {
    let payload: unknown;
    try {
      payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
    const p = typeof payload === 'object' && payload ? (payload as Record<string, unknown>) : {};
    if (p.typ !== 'tenant' || typeof p.sub !== 'string' || typeof p.tid !== 'string' || !UUID_RE.test(p.tid)) throw new UnauthorizedError('Invalid or expired token');
    return { sub: p.sub, tid: p.tid, ...(typeof p.sid === 'string' && UUID_RE.test(p.sid) ? { sid: p.sid } : {}), ...(typeof p.at === 'number' ? { at: p.at } : {}) };
  }

  /**
   * Must run inside `runWithTenant(claims.tid)`. Confirms the user still exists IN THAT BUSINESS (a user id from another business, with
   * this tenant's claim, finds nothing), takes the current role from the database, and refuses suspended businesses.
   */
  async authenticateClaims(claims: { sub: string; tid: string; at?: number }): Promise<AuthUser> {
    const user = await this.users.findForAuth(claims.sub);
    if (!user) throw new UnauthorizedError('Invalid or expired token');
    if (user.validAfterMs > 0 && (claims.at === undefined || claims.at < user.validAfterMs)) throw new UnauthorizedError('Invalid or expired token'); // logged out everywhere since this token was issued
    const status = await this.tenants?.currentStatus();
    if (status !== undefined && status !== 'ACTIVE') throw new ForbiddenError('This business account is suspended. Please contact support.');
    return { id: user.id, email: user.email, role: user.role, tenantId: claims.tid };
  }
}
