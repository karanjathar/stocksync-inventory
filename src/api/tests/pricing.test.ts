import { describe, expect, it } from 'vitest';
import { priceOrder, roundDiv, type PriceLineInput } from '../src/domain/pricing.js';

const line = (over: Partial<PriceLineInput> = {}): PriceLineInput => ({ unitPriceCents: 1000, quantity: 1, rateBp: 0, ...over });

describe('roundDiv (half-up integer division)', () => {
  it('rounds .5 up and never uses floats', () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(4n, 2n)).toBe(2n);
    expect(roundDiv(14n, 3n)).toBe(5n);   // 4.67 -> 5
    expect(roundDiv(13n, 3n)).toBe(4n);   // 4.33 -> 4
    expect(roundDiv(0n, 7n)).toBe(0n);
  });
});

describe('priceOrder: tax exclusive (price + tax)', () => {
  it('adds GST on top and keeps total = subtotal + tax', () => {
    const r = priceOrder({ lines: [line({ unitPriceCents: 1000, quantity: 2, rateBp: 1800 })], inclusive: false });
    expect(r).toMatchObject({ subtotalCents: 2000, discountCents: 0, taxCents: 360, totalCents: 2360 });
    expect(r.lines[0]).toMatchObject({ grossCents: 2000, discountCents: 0, netCents: 2000, taxCents: 360, totalCents: 2360 });
  });

  it('rounds each line half-up and totals are the sum of the rounded lines (no second rounding)', () => {
    // 5% of 333 = 16.65 -> 17 ; 5% of 330 = 16.5 -> 17 ; 5% of 329 = 16.45 -> 16
    const r = priceOrder({ lines: [line({ unitPriceCents: 333, rateBp: 500 }), line({ unitPriceCents: 330, rateBp: 500 }), line({ unitPriceCents: 329, rateBp: 500 })], inclusive: false });
    expect(r.lines.map((l) => l.taxCents)).toEqual([17, 17, 16]);
    expect(r.taxCents).toBe(50);
    expect(r.totalCents).toBe(333 + 330 + 329 + 50);
  });

  it('a product without a tax rate is untaxed', () => {
    expect(priceOrder({ lines: [line({ unitPriceCents: 777, quantity: 3 })], inclusive: false })).toMatchObject({ taxCents: 0, totalCents: 2331 });
  });
});

describe('priceOrder: tax inclusive (prices already contain GST)', () => {
  it('extracts the tax from the price and does not change the total', () => {
    const r = priceOrder({ lines: [line({ unitPriceCents: 1180, rateBp: 1800 })], inclusive: true });
    expect(r).toMatchObject({ subtotalCents: 1000, taxCents: 180, totalCents: 1180 });
  });

  it('total = subtotal + tax holds even when rounding bites', () => {
    const r = priceOrder({ lines: [line({ unitPriceCents: 999, quantity: 3, rateBp: 1200 })], inclusive: true });
    expect(r.totalCents).toBe(2997);
    expect(r.subtotalCents + r.taxCents).toBe(r.totalCents);
  });
});

describe('priceOrder: discounts', () => {
  it('applies a fixed line discount before tax', () => {
    const r = priceOrder({ lines: [line({ unitPriceCents: 1000, quantity: 2, rateBp: 1800, discount: { type: 'fixed', cents: 500 } })], inclusive: false });
    expect(r.lines[0]).toMatchObject({ grossCents: 2000, discountCents: 500, netCents: 1500, taxCents: 270, totalCents: 1770 });
  });

  it('applies a percentage line discount in basis points (12.5%)', () => {
    const r = priceOrder({ lines: [line({ unitPriceCents: 1000, discount: { type: 'percent', basisPoints: 1250 } })], inclusive: false });
    expect(r.lines[0]).toMatchObject({ discountCents: 125, netCents: 875, totalCents: 875 });
  });

  it('allocates an order discount across lines exactly (largest remainder), taxing each line on its share', () => {
    const r = priceOrder({
      lines: [line({ unitPriceCents: 1000, rateBp: 500 }), line({ unitPriceCents: 1000, rateBp: 1800 }), line({ unitPriceCents: 1000, rateBp: 0 })],
      orderDiscount: { type: 'fixed', cents: 100 }, inclusive: false,
    });
    expect(r.discountCents).toBe(100);
    expect(r.lines.map((l) => l.discountCents)).toEqual([34, 33, 33]); // 100 / 3 with the extra cent to the first
    expect(r.lines.map((l) => l.netCents)).toEqual([966, 967, 967]);
    expect(r.totalCents).toBe(r.lines.reduce((n, l) => n + l.totalCents, 0));
    expect(r.subtotalCents + r.taxCents).toBe(r.totalCents);
  });

  it('a percentage order discount is computed on the amount after line discounts', () => {
    const r = priceOrder({ lines: [line({ unitPriceCents: 1000, discount: { type: 'fixed', cents: 200 } }), line({ unitPriceCents: 1000 })], orderDiscount: { type: 'percent', basisPoints: 1000 }, inclusive: false });
    expect(r.discountCents).toBe(200 + 180); // 10% of 1800
    expect(r.totalCents).toBe(1620);
  });

  it('refuses discounts larger than the amount', () => {
    expect(() => priceOrder({ lines: [line({ discount: { type: 'fixed', cents: 1001 } })], inclusive: false })).toThrow(/exceeds/i);
    expect(() => priceOrder({ lines: [line()], orderDiscount: { type: 'fixed', cents: 1001 }, inclusive: false })).toThrow(/exceeds/i);
    expect(() => priceOrder({ lines: [line()], orderDiscount: { type: 'percent', basisPoints: 10001 }, inclusive: false })).toThrow(/exceeds/i);
    expect(() => priceOrder({ lines: [line({ discount: { type: 'fixed', cents: -1 } })], inclusive: false })).toThrow();
  });

  it('a 100% discount makes a free order with no tax', () => {
    const r = priceOrder({ lines: [line({ rateBp: 1800 })], orderDiscount: { type: 'percent', basisPoints: 10000 }, inclusive: false });
    expect(r).toMatchObject({ totalCents: 0, taxCents: 0, discountCents: 1000 });
  });
});

describe('priceOrder: limits and invariants', () => {
  it('does not lose precision on large values (BigInt maths)', () => {
    const r = priceOrder({ lines: [line({ unitPriceCents: 800_000_000, quantity: 1, rateBp: 2800 })], inclusive: false });
    expect(r.taxCents).toBe(224_000_000);
    expect(r.totalCents).toBe(1_024_000_000);
  });

  it('rejects totals above the 32-bit column limit', () => {
    expect(() => priceOrder({ lines: [line({ unitPriceCents: 1_000_000_000, quantity: 3 })], inclusive: false })).toThrow(/too large/i);
  });

  it('rejects empty orders and bad rates', () => {
    expect(() => priceOrder({ lines: [], inclusive: false })).toThrow();
    expect(() => priceOrder({ lines: [line({ rateBp: -1 })], inclusive: false })).toThrow();
    expect(() => priceOrder({ lines: [line({ rateBp: 10001 })], inclusive: false })).toThrow();
  });

  it('random orders always satisfy the invariants (1000 cases)', () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const rates = [0, 500, 1200, 1800, 2800];
    for (let i = 0; i < 1000; i++) {
      const lines = Array.from({ length: 1 + rnd(5) }, () => line({ unitPriceCents: 1 + rnd(50_000), quantity: 1 + rnd(20), rateBp: rates[rnd(5)]!, ...(rnd(3) === 0 ? { discount: { type: 'percent' as const, basisPoints: rnd(5000) } } : {}) }));
      const inclusive = rnd(2) === 1;
      const orderDiscount = rnd(3) === 0 ? { type: 'percent' as const, basisPoints: rnd(3000) } : undefined;
      const r = priceOrder({ lines, orderDiscount, inclusive });
      expect(r.totalCents).toBe(r.lines.reduce((n, l) => n + l.totalCents, 0));
      expect(r.taxCents).toBe(r.lines.reduce((n, l) => n + l.taxCents, 0));
      expect(r.subtotalCents + r.taxCents).toBe(r.totalCents);
      expect(r.discountCents).toBe(r.lines.reduce((n, l) => n + l.discountCents, 0));
      for (const l of r.lines) { expect(l.netCents).toBeGreaterThanOrEqual(0); expect(l.netCents).toBe(l.grossCents - l.discountCents); }
    }
  });
});
