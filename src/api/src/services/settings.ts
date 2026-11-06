import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { ValidationError } from '../domain/errors.js';
import type { Settings } from '../domain/types.js';

export const DEFAULT_SETTINGS: Settings = {
  businessName: 'StockSync',
  currency: 'USD',
  whatsappNumber: '',
  defaultWarehouseId: null,
  alertRecipients: [],
  customFields: [],
  payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 },
};

export const settingsPatchSchema = z.object({
  businessName: z.string().trim().min(1).max(120).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'ISO 4217 code').optional(),
  whatsappNumber: z.string().trim().regex(/^(\+?[0-9]{6,15})?$/, 'digits only, international format').optional(),
  defaultWarehouseId: z.string().uuid().nullable().optional(),
  alertRecipients: z.array(z.object({
    channel: z.enum(['whatsapp', 'messenger', 'instagram', 'telegram']),
    to: z.string().trim().min(1).max(100),
  })).max(20).optional(),
  customFields: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase letters, digits, underscore'),
    label: z.string().trim().min(1).max(60),
    type: z.enum(['text', 'number', 'select']),
    options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  })).max(50).optional(),
  payments: z.object({
    onlineEnabled: z.boolean(),
    codEnabled: z.boolean(),
    linkExpiryMinutes: z.number().int().min(15).max(7 * 24 * 60),
  }).optional(),
});

export class SettingsService {
  constructor(private readonly db: Queryable) {}

  async get(): Promise<Settings> {
    const { rows } = await this.db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...pickKnown(stored) };
  }

  async update(patch: z.infer<typeof settingsPatchSchema>): Promise<Settings> {
    if (patch.defaultWarehouseId) {
      const w = await this.db.query('SELECT 1 FROM warehouses WHERE id = $1', [patch.defaultWarehouseId]);
      if (!w.rowCount) throw new ValidationError('Invalid request', [{ path: 'defaultWarehouseId', message: 'warehouse not found' }]);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      await this.db.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, JSON.stringify(value)]);
    }
    return this.get();
  }
}

function pickKnown(s: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (k in s) (out as Record<string, unknown>)[k] = s[k];
  }
  return out;
}
