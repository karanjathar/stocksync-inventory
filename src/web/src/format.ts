let locale: string | undefined; // set by the language provider; undefined = the browser's own
export function setFormatLocale(l: string | undefined): void { locale = l; }

export function money(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Parses "12.50" → 1250 cents; returns NaN for invalid input. */
export function toCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return Number.NaN;
  return Math.round(Number(value) * 100);
}

export function whatsappLink(number: string, text: string): string {
  return `https://wa.me/${number.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(text)}`;
}
