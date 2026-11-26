import type { Queryable } from '../db/pool.js';
import type { Role, User } from '../domain/types.js';

const COLS = `id, email, name, role, created_at AS "createdAt"`;

export interface UserWithHash extends User { passwordHash: string }
export interface LoginRecord extends UserWithHash { tenantId: string; tenantStatus: string }

export class UsersRepo {
  constructor(private readonly db: Queryable) {}

  async create(u: { email: string; passwordHash: string; name: string; role: Role }): Promise<User> {
    const { rows } = await this.db.query<User>(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [u.email, u.passwordHash, u.name, u.role],
    );
    return rows[0]!;
  }

  async findByEmailWithHash(email: string): Promise<UserWithHash | undefined> {
    const { rows } = await this.db.query<UserWithHash>(
      `SELECT ${COLS}, password_hash AS "passwordHash" FROM users WHERE email = $1`, [email],
    );
    return rows[0];
  }

  /** Login before any tenant is known: finds the user across businesses through the narrow login_lookup() function. */
  async findForLogin(email: string): Promise<LoginRecord | undefined> {
    const { rows } = await this.db.query<LoginRecord>(
      `SELECT id, email, name, role, created_at AS "createdAt", password_hash AS "passwordHash", tenant_id AS "tenantId", tenant_status AS "tenantStatus" FROM login_lookup($1)`, [email]);
    return rows[0];
  }

  async findById(id: string): Promise<User | undefined> {
    const { rows } = await this.db.query<User>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
    return rows[0];
  }

  /** The user plus the moment before which every token is void ("log out everywhere"), in milliseconds. */
  async findForAuth(id: string): Promise<(User & { validAfterMs: number }) | undefined> {
    const { rows } = await this.db.query<User & { validAfterMs: number }>(`SELECT ${COLS}, (extract(epoch FROM sessions_valid_after) * 1000)::float8 AS "validAfterMs" FROM users WHERE id = $1`, [id]);
    return rows[0];
  }

  async list(): Promise<User[]> {
    const { rows } = await this.db.query<User>(`SELECT ${COLS} FROM users ORDER BY created_at`);
    return rows;
  }

  async update(id: string, patch: { name?: string; role?: Role; passwordHash?: string }): Promise<User | undefined> {
    const { rows } = await this.db.query<User>(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), password_hash = COALESCE($4, password_hash)
       WHERE id = $1 RETURNING ${COLS}`,
      [id, patch.name ?? null, patch.role ?? null, patch.passwordHash ?? null],
    );
    return rows[0];
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM users WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    return rows[0]!.n;
  }
}
