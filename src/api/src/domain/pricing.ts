import { ValidationError } from './errors.js';

/**
 * Order pricing in integer minor units (docs/3_SCHEMAS.md §3.16, decision D-011).
 * Rounding: half-up, once per line. Order totals are the sums of the rounded line values, never re-rounded.
 * Products/lines use BigInt for products so 10^14 x 10^4 cannot lose precision.
 */
export type Discount = { type: 'percent'; basisPoints: number } | { type: 'fixed'; cents: number };

export interface PriceLineInput { unitPriceCents: number; quantity: number; rateBp: number; discount?: Discount }
export interface PricedLine { grossCents: number; discountCents: number; netCents: number; taxCents: number; totalCents: number }
export interface PricedOrder { lines: PricedLine[]; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number }

/** The orders.total_cents column is a 32-bit integer. */
export const MAX_ORDER_CENTS = 2_147_483_647;

/** Half-up integer division for non-negative values. */
export function roundDiv(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

function discountAmount(d: Discount | undefined, base: bigint, what: string): bigint {
  if (!d) return 0n;
  let amount: bigint;
  if (d.type === 'percent') {
    if (!Number.isInteger(d.basisPoints) || d.basisPoints < 0) throw new ValidationError(`${what} percentage is invalid`);
    if (d.basisPoints > 10_000) throw new ValidationError(`${what} exceeds the amount`);
    amount = roundDiv(base * BigInt(d.basisPoints), 10_000n);
  } else {
    if (!Number.isInteger(d.cents) || d.cents < 0) throw new ValidationError(`${what} amount is invalid`);
    amount = BigInt(d.cents);
  }
  if (amount > base) throw new ValidationError(`${what} exceeds the amount`);
  return amount;
}

export function priceOrder(input: { lines: PriceLineInput[]; orderDiscount?: Discount; inclusive: boolean }): PricedOrder {
  if (!input.lines.length) throw new ValidationError('An order needs at least one item');
  const gross: bigint[] = [];
  const lineDiscount: bigint[] = [];
  for (const l of input.lines) {
    if (!Number.isInteger(l.rateBp) || l.rateBp < 0 || l.rateBp > 10_000) throw new ValidationError('Tax rate is invalid');
    const g = BigInt(l.unitPriceCents) * BigInt(l.quantity);
    gross.push(g);
    lineDiscount.push(discountAmount(l.discount, g, 'Line discount'));
  }
  const afterLine = gross.map((g, i) => g - lineDiscount[i]!);
  const sum = afterLine.reduce((a, b) => a + b, 0n);
  const orderDiscount = discountAmount(input.orderDiscount, sum, 'Order discount');

  // Largest-remainder allocation: shares add up to the discount exactly.
  const alloc = afterLine.map(() => 0n);
  if (orderDiscount > 0n && sum > 0n) {
    const base = afterLine.map((a) => (orderDiscount * a) / sum);
    const rem = afterLine.map((a, i) => ({ i, r: (orderDiscount * a) % sum }));
    let left = orderDiscount - base.reduce((a, b) => a + b, 0n);
    rem.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
    for (const { i } of rem) { if (left <= 0n) break; base[i]! += 1n; left -= 1n; }
    base.forEach((b, i) => { alloc[i] = b; });
  }

  const lines: PricedLine[] = input.lines.map((l, i) => {
    const net = afterLine[i]! - alloc[i]!;
    const rate = BigInt(l.rateBp);
    const tax = input.inclusive ? roundDiv(net * rate, 10_000n + rate) : roundDiv(net * rate, 10_000n);
    const total = input.inclusive ? net : net + tax;
    return {
      grossCents: Number(gross[i]!), discountCents: Number(lineDiscount[i]! + alloc[i]!), netCents: Number(net),
      taxCents: Number(tax), totalCents: Number(total),
    };
  });
  const sumOf = (f: (l: PricedLine) => number) => lines.reduce((n, l) => n + f(l), 0);
  const totalCents = sumOf((l) => l.totalCents);
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_ORDER_CENTS) throw new ValidationError('Order total is too large');
  const taxCents = sumOf((l) => l.taxCents);
  return { lines, subtotalCents: totalCents - taxCents, discountCents: sumOf((l) => l.discountCents), taxCents, totalCents };
}
