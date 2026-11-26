/** Barcodes are stored upper-case and trimmed so a scan, a keyboard-wedge scanner and manual typing all match. */
export const normaliseBarcode = (raw: string): string => raw.trim().toUpperCase();

/** EAN-13 check digit: weights 1,3,1,3… over the first twelve digits. */
function ean13Ok(code: string): boolean {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/** 8–48 characters scanners actually produce; thirteen digits must carry a correct EAN-13 check digit. Expects a normalised code. */
export function validBarcode(code: string): boolean {
  if (!/^[A-Z0-9][A-Z0-9._/-]{7,47}$/.test(code)) return false;
  return /^\d{13}$/.test(code) ? ean13Ok(code) : true;
}
