import { ValidationError } from '../domain/errors.js';

/** One invoice line as input: price per unit in paise, GST rate in basis points (1800 = 18 %). */
export interface GstLineInput { productId: string; sku: string; name: string; hsnCode: string | null; gstRateBp: number; quantity: number; unitPriceCents: number }
export interface GstLine extends GstLineInput { grossCents: number; taxableCents: number; taxCents: number }
export interface GstInvoiceTotals {
  lines: GstLine[]; interState: boolean;
  taxableCents: number; cgstCents: number; sgstCents: number; igstCents: number; taxCents: number; totalCents: number;
}
export interface ComputeInput { lines: GstLineInput[]; pricesIncludeTax: boolean; sellerStateCode: string; buyerStateCode: string | null }

/** a / b rounded half up, exact (BigInt: 1e14 paise × 1e4 would overflow a double). */
const divRound = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

/**
 * GST per docs/3_SCHEMAS.md 3.20, in integer paise, tax computed per line so every number on the invoice adds up exactly.
 * Inclusive prices (MRP): taxable = round(gross × 10000 / (10000 + rate)), tax = gross − taxable; the total equals what the customer paid.
 * Exclusive prices: taxable = gross, tax = round(gross × rate / 10000), total = taxable + tax.
 * Same state (or buyer state unknown): CGST = floor(tax / 2), SGST = the rest. Other state: IGST = tax.
 */
export function computeInvoice(input: ComputeInput): GstInvoiceTotals {
  const bad = (message: string): never => { throw new ValidationError('Invalid invoice input', [{ path: 'lines', message }]); };
  if (!input.lines.length) bad('an invoice needs at least one line');
  if (!input.sellerStateCode) bad('the seller state code is not set');
  const interState = input.buyerStateCode !== null && input.buyerStateCode !== input.sellerStateCode;

  const lines: GstLine[] = input.lines.map((l) => {
    if (!Number.isInteger(l.quantity) || l.quantity < 1) bad(`quantity of ${l.sku} must be a whole number of at least 1`);
    if (!Number.isInteger(l.unitPriceCents) || l.unitPriceCents < 0) bad(`price of ${l.sku} must be a non-negative whole number of paise`);
    if (!Number.isInteger(l.gstRateBp) || l.gstRateBp < 0 || l.gstRateBp > 2800) bad(`GST rate of ${l.sku} must be between 0 and 28 %`);
    const gross = BigInt(l.unitPriceCents) * BigInt(l.quantity);
    const rate = BigInt(l.gstRateBp);
    let taxable: bigint; let tax: bigint;
    if (input.pricesIncludeTax) { taxable = divRound(gross * 10000n, 10000n + rate); tax = gross - taxable; }
    else { taxable = gross; tax = divRound(gross * rate, 10000n); }
    return { ...l, grossCents: Number(gross), taxableCents: Number(taxable), taxCents: Number(tax) };
  });

  const taxableCents = lines.reduce((s, l) => s + l.taxableCents, 0);
  const taxCents = lines.reduce((s, l) => s + l.taxCents, 0);
  const cgstCents = interState ? 0 : Math.floor(taxCents / 2);
  return {
    lines, interState, taxableCents, taxCents, totalCents: taxableCents + taxCents,
    cgstCents, sgstCents: interState ? 0 : taxCents - cgstCents, igstCents: interState ? taxCents : 0,
  };
}
