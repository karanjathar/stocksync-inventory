import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { ValidationError } from '../domain/errors.js';
import { NOTIFICATION_EVENTS, TEMPLATE_PARAMS, type Settings } from '../domain/types.js';

export const DEFAULT_SETTINGS: Settings = {
  businessName: 'StockSync',
  currency: 'USD',
  whatsappNumber: '',
  defaultWarehouseId: null,
  alertRecipients: [],
  customFields: [],
  payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 },
  whatsappTemplates: {},
  maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 365 },
  gst: { legalName: '', gstin: '', address: '', stateCode: '', invoicePrefix: 'INV', pricesIncludeTax: true },
};

/** GSTIN: 2-digit state, PAN (5 letters, 4 digits, 1 letter), entity number, 'Z', check character. */
export const GSTIN_RE = /^(0[1-9]|[12][0-9]|3[0-8]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const STATE_CODE_RE = /^(0[1-9]|[12][0-9]|3[0-8]|97|99)$/;

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
  // Release 3: event → approved WhatsApp template (created in WhatsApp Manager; we only map names).
  whatsappTemplates: z.partialRecord(z.enum(NOTIFICATION_EVENTS), z.object({
    name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'lowercase letters, digits, underscore'),
    language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'e.g. en or en_US'),
    params: z.array(z.enum(TEMPLATE_PARAMS)).max(10),
  })).optional(),
  gst: z.object({
    legalName: z.string().trim().max(200),
    gstin: z.string().trim().toUpperCase().refine((v) => v === '' || GSTIN_RE.test(v), 'not a valid GSTIN (15 characters)'),
    address: z.string().trim().max(500),
    stateCode: z.string().trim().refine((v) => v === '' || STATE_CODE_RE.test(v), '2-digit GST state code, e.g. 27'),
    invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'up to 8 letters or digits'),
    pricesIncludeTax: z.boolean(),
  }).refine((g) => !g.gstin || !g.stateCode || g.gstin.slice(0, 2) === g.stateCode, { message: 'state code must match the first two digits of the GSTIN', path: ['stateCode'] }).optional(),
  maintenance: z.object({
    unpaidOrderTtlHours: z.number().int().min(1).max(720),
    chatRetentionDays: z.number().int().min(0).max(3650),
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
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value',
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
