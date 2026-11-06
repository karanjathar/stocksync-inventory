import type pg from 'pg';
import { NotFoundError } from '../domain/errors.js';
import type { TaxRate } from '../domain/types.js';

const SELECT = 'SELECT id, name, rate_bp AS "rateBp", active FROM tax_rates';

/** Named tax rates (e.g. GST 18%). Rates are copied onto each order line, so editing one never changes past orders. */
export class TaxRatesService {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<TaxRate[]> {
    const { rows } = await this.pool.query<TaxRate>(`${SELECT} ORDER BY rate_bp, name`);
    return rows;
  }

  async create(input: { name: string; rateBp: number }): Promise<TaxRate> {
    const { rows } = await this.pool.query<TaxRate>(
      'INSERT INTO tax_rates (name, rate_bp) VALUES ($1, $2) RETURNING id, name, rate_bp AS "rateBp", active', [input.name, input.rateBp]);
    return rows[0]!;
  }

  async update(id: string, patch: { name?: string; rateBp?: number; active?: boolean }): Promise<TaxRate> {
    const { rows } = await this.pool.query<TaxRate>(
      `UPDATE tax_rates SET name = COALESCE($2, name), rate_bp = COALESCE($3, rate_bp), active = COALESCE($4, active)
       WHERE id = $1 RETURNING id, name, rate_bp AS "rateBp", active`, [id, patch.name ?? null, patch.rateBp ?? null, patch.active ?? null]);
    if (!rows[0]) throw new NotFoundError('Tax rate');
    return rows[0];
  }
}
