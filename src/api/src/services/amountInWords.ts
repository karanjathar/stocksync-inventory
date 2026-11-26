const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]!); n %= 10; }
  if (n > 0) parts.push(ONES[n]!);
  return parts.join(' ');
}

/** Whole number in the Indian system (thousand, lakh, crore). Crores repeat above 99 (e.g. "Two Hundred Fifty Crore"). */
function indian(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000); n %= 10_000_000;
  const lakh = Math.floor(n / 100_000); n %= 100_000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${indian(crore)} Crore`);
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

/** "One Hundred Eighteen Rupees and Fifty Paise Only" for an amount in paise (integers only). */
export function amountInWords(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('amount must be a non-negative whole number of paise');
  const rupees = Math.floor(cents / 100);
  const paise = cents % 100;
  const r = `${indian(rupees)} ${rupees === 1 ? 'Rupee' : 'Rupees'}`;
  const p = `${indian(paise)} ${paise === 1 ? 'Paisa' : 'Paise'}`;
  if (rupees === 0 && paise > 0) return `${p} Only`;
  return paise > 0 ? `${r} and ${p} Only` : `${r} Only`;
}
