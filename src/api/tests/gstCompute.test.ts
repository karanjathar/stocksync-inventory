import { describe, expect, it } from 'vitest';
import { computeInvoice, type GstLineInput } from '../src/services/gst.js';

const line = (over: Partial<GstLineInput> = {}): GstLineInput => ({ productId: 'p', sku: 'S', name: 'N', hsnCode: '6109', gstRateBp: 1800, quantity: 1, unitPriceCents: 11800, ...over });
const inclusive = (lines: GstLineInput[], buyerStateCode: string | null = '27') => computeInvoice({ lines, pricesIncludeTax: true, sellerStateCode: '27', buyerStateCode });

describe('computeInvoice (tax-inclusive prices)', () => {
  it('backs the tax out of an MRP: 118.00 at 18% = 100.00 + 18.00', () => {
    const r = inclusive([line()]);
    expect(r).toMatchObject({ taxableCents: 10000, taxCents: 1800, totalCents: 11800, interState: false, cgstCents: 900, sgstCents: 900, igstCents: 0 });
    expect(r.lines[0]).toMatchObject({ grossCents: 11800, taxableCents: 10000, taxCents: 1800 });
  });

  it('uses IGST when the buyer is in another state, CGST+SGST in the same state or when the buyer has no state', () => {
    expect(inclusive([line()], '29')).toMatchObject({ interState: true, igstCents: 1800, cgstCents: 0, sgstCents: 0 });
    expect(inclusive([line()], '27').interState).toBe(false);
    expect(inclusive([line()], null).interState).toBe(false);
  });

  it('splits an odd tax amount without losing a paisa (CGST rounds down, SGST takes the rest)', () => {
    // 105 at 5%: taxable 100, tax 5 → 2 + 3
    const r = inclusive([line({ gstRateBp: 500, unitPriceCents: 105 })]);
    expect(r).toMatchObject({ taxableCents: 100, taxCents: 5, cgstCents: 2, sgstCents: 3 });
  });

  it('rounds half up per line and keeps the total equal to what the customer paid', () => {
    const r = inclusive([line({ gstRateBp: 1200, unitPriceCents: 999, quantity: 3 }), line({ gstRateBp: 500, unitPriceCents: 1 })]);
    expect(r.totalCents).toBe(999 * 3 + 1);
    expect(r.taxableCents + r.taxCents).toBe(r.totalCents);
    expect(r.lines.reduce((s, l) => s + l.taxCents, 0)).toBe(r.taxCents);
  });

  it('handles 0% goods, free items and very large amounts exactly', () => {
    expect(inclusive([line({ gstRateBp: 0, unitPriceCents: 500 })])).toMatchObject({ taxableCents: 500, taxCents: 0, totalCents: 500 });
    expect(inclusive([line({ unitPriceCents: 0 })])).toMatchObject({ taxableCents: 0, taxCents: 0, totalCents: 0 });
    const big = inclusive([line({ unitPriceCents: 1_000_000_000, quantity: 100_000 })]); // 1e14 paise, beyond 32-bit and 1e18 intermediates
    expect(big.totalCents).toBe(100_000_000_000_000);
    expect(big.taxableCents + big.taxCents).toBe(big.totalCents);
    expect(big.taxableCents).toBe(Math.round(100_000_000_000_000 / 1.18));
  });

  it('rejects impossible input', () => {
    for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { unitPriceCents: -1 }, { gstRateBp: -1 }, { gstRateBp: 2801 }, { unitPriceCents: 1.2 }]) {
      expect(() => inclusive([line(bad)]), JSON.stringify(bad)).toThrow();
    }
    expect(() => computeInvoice({ lines: [], pricesIncludeTax: true, sellerStateCode: '27', buyerStateCode: null })).toThrow();
    expect(() => computeInvoice({ lines: [line()], pricesIncludeTax: true, sellerStateCode: '', buyerStateCode: null })).toThrow();
  });
});

describe('computeInvoice (tax-exclusive prices)', () => {
  it('adds tax on top: 100.00 at 18% = 18.00 tax, total 118.00', () => {
    const r = computeInvoice({ lines: [line({ unitPriceCents: 10000 })], pricesIncludeTax: false, sellerStateCode: '27', buyerStateCode: null });
    expect(r).toMatchObject({ taxableCents: 10000, taxCents: 1800, totalCents: 11800 });
  });
});

/** Deterministic pseudo-random generator so a failure is reproducible. */
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('computeInvoice invariants over random carts', () => {
  it('always reconciles exactly, in both pricing modes and for same-state and inter-state sales', () => {
    const rand = rng(20261126);
    const RATES = [0, 25, 300, 500, 1200, 1800, 2800, 1, 1799];
    for (let i = 0; i < 3000; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => line({
        gstRateBp: RATES[Math.floor(rand() * RATES.length)]!, quantity: 1 + Math.floor(rand() * 50), unitPriceCents: Math.floor(rand() * 5_000_000),
      }));
      const includeTax = rand() < 0.5;
      const buyer = rand() < 0.4 ? '29' : rand() < 0.5 ? '27' : null;
      const r = computeInvoice({ lines, pricesIncludeTax: includeTax, sellerStateCode: '27', buyerStateCode: buyer });
      const ctx = JSON.stringify({ i, includeTax, buyer, lines });
      expect(r.lines.reduce((s, l) => s + l.taxCents, 0), ctx).toBe(r.taxCents);
      expect(r.lines.reduce((s, l) => s + l.taxableCents, 0), ctx).toBe(r.taxableCents);
      expect(r.taxableCents + r.taxCents, ctx).toBe(r.totalCents);
      expect(r.cgstCents + r.sgstCents + r.igstCents, ctx).toBe(r.taxCents);
      if (r.interState) { expect(r.cgstCents + r.sgstCents, ctx).toBe(0); } else { expect(r.igstCents, ctx).toBe(0); expect(r.sgstCents - r.cgstCents, ctx).toBeGreaterThanOrEqual(0); expect(r.sgstCents - r.cgstCents, ctx).toBeLessThanOrEqual(1); }
      const gross = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
      if (includeTax) expect(r.totalCents, ctx).toBe(gross); else expect(r.taxableCents, ctx).toBe(gross);
      for (const l of r.lines) { expect(l.taxableCents).toBeGreaterThanOrEqual(0); expect(l.taxCents).toBeGreaterThanOrEqual(0); }
    }
  });
});
