export function money(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Parses "12.50" → 1250 cents; returns NaN for invalid input. */
export function toCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return Number.NaN;
  return Math.round(Number(value) * 100);
}

export function whatsappLink(number: string, text: string): string {
  return `https://wa.me/${number.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(text)}`;
}

export type DiscountInput = { type: 'percent'; basisPoints: number } | { type: 'fixed'; cents: number };

/** "10%" -> 10 percent, "5.00" -> 500 minor units, "" -> no discount (null). Anything else -> undefined (invalid). */
export function parseDiscount(text: string): DiscountInput | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (t.endsWith('%')) {
    const bp = parsePercentBp(t.slice(0, -1));
    return Number.isNaN(bp) ? undefined : { type: 'percent', basisPoints: bp };
  }
  const cents = toCents(t);
  return Number.isNaN(cents) ? undefined : { type: 'fixed', cents };
}

/** "18" -> 1800 basis points, "12.5" -> 1250; NaN when invalid or above 100. */
export function parsePercentBp(text: string): number {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  const bp = Math.round(Number(t) * 100);
  return bp > 10_000 ? Number.NaN : bp;
}
