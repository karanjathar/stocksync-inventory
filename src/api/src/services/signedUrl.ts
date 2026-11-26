import { createHmac, timingSafeEqual } from 'node:crypto';

/** Key separation: the same secret never signs two different kinds of thing. */
const mac = (secret: string, invoiceId: string, exp: number) => createHmac('sha256', secret).update(`invoice-download|${invoiceId}|${exp}`).digest();

/** Link a customer (or WhatsApp's servers) can open without a login: bound to one invoice, valid until `exp`. */
export function signInvoiceUrl(secret: string, baseUrl: string, invoiceId: string, ttlMs: number, now: Date = new Date()): string {
  const exp = Math.floor((now.getTime() + ttlMs) / 1000);
  return `${baseUrl.replace(/\/$/, '')}/api/public/invoices/${invoiceId}/download.pdf?exp=${exp}&sig=${mac(secret, invoiceId, exp).toString('hex')}`;
}

export function verifyInvoiceSignature(secret: string, invoiceId: string, exp: string, sig: string, now: Date = new Date()): boolean {
  if (!/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expSeconds = Number(exp);
  if (expSeconds * 1000 < now.getTime()) return false;
  return timingSafeEqual(mac(secret, invoiceId, expSeconds), Buffer.from(sig, 'hex'));
}
