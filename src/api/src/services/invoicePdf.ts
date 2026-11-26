import PDFDocument from 'pdfkit';
import { amountInWords } from './amountInWords.js';
import type { Invoice } from './invoices.js';

/**
 * Text for a standard PDF font (Helvetica, Latin-1 only): control characters are dropped, newlines and tabs become spaces and anything the
 * font cannot draw (Devanagari, ₹, emoji…) becomes "?". Known limitation until a Unicode font is bundled (see task "Embed a Unicode font").
 */
export function pdfSafe(text: string, max = 200): string {
  let out = '';
  let lastWasBreak = false;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a || c === 0x0d || c === 0x09) { // line breaks and tabs collapse into a single space
      if (!lastWasBreak) out += ' ';
      lastWasBreak = true;
      continue;
    }
    lastWasBreak = false;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue; // other control characters are dropped
    out += (c <= 0x7e) || (c >= 0xa0 && c <= 0xff) ? ch : '?';
  }
  return Array.from(out).slice(0, max).join('');
}

/** 1234567 paise → "Rs. 12,345.67" with Indian digit grouping (the ₹ sign is not in the standard font). */
export function inr(cents: number): string {
  const whole = Math.floor(cents / 100).toString();
  const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  return `Rs. ${grouped}.${String(cents % 100).padStart(2, '0')}`;
}

const istDate = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso)).replace(/\//g, '-');

const COLS = [
  { key: 'item', label: 'Item', x: 36, w: 178, align: 'left' }, { key: 'hsn', label: 'HSN/SAC', x: 218, w: 50, align: 'left' },
  { key: 'qty', label: 'Qty', x: 270, w: 28, align: 'right' }, { key: 'taxable', label: 'Taxable value', x: 300, w: 78, align: 'right' },
  { key: 'rate', label: 'GST', x: 380, w: 36, align: 'right' }, { key: 'tax', label: 'Tax', x: 418, w: 64, align: 'right' },
  { key: 'amount', label: 'Amount', x: 484, w: 75, align: 'right' },
] as const;

/** Renders an issued invoice (from its immutable snapshot) as an A4 PDF. `compress:false` is for tests. */
export function renderInvoicePdf(invoice: Invoice, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const s = invoice.snapshot;
  const doc = new PDFDocument({ size: 'A4', margin: 36, compress: opts.compress ?? true, info: { Title: `Tax invoice ${pdfSafe(invoice.number)}`, Producer: 'StockSync' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const text = (value: string, x: number, y: number, width: number, align: 'left' | 'right' | 'center' = 'left') =>
    doc.text(pdfSafe(value), x, y, { width, align, lineBreak: false, ellipsis: true, height: 12 });
  const watermark = () => {
    if (invoice.status !== 'VOID') return;
    doc.save().fillColor('#d33', 0.18).font('Helvetica-Bold').fontSize(110).rotate(-30, { origin: [300, 420] }).text('VOID', 150, 380, { lineBreak: false }).restore();
  };
  const header = (y: number): number => {
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(16); text('TAX INVOICE', 36, y, 300);
    doc.font('Helvetica').fontSize(9);
    text(`Invoice No: ${s.number}`, 340, y, 219, 'right'); text(`Date: ${istDate(s.issuedAt)}`, 340, y + 13, 219, 'right'); text(`Order #${s.order.number}`, 340, y + 26, 219, 'right');
    doc.font('Helvetica-Bold').fontSize(11); text(s.seller.legalName, 36, y + 30, 290);
    doc.font('Helvetica').fontSize(9);
    doc.text(pdfSafe(s.seller.address, 300), 36, y + 45, { width: 290, height: 24 });
    text(`GSTIN: ${s.seller.gstin}   State code: ${s.seller.stateCode}`, 36, y + 72, 290);
    doc.moveTo(36, y + 90).lineTo(559, y + 90).strokeColor('#999').stroke();
    doc.font('Helvetica-Bold'); text('Bill to', 36, y + 98, 100); doc.font('Helvetica');
    text(s.buyer.name, 36, y + 111, 290);
    if (s.buyer.gstin) text(`GSTIN: ${s.buyer.gstin}`, 36, y + 124, 290);
    text(`Place of supply (state code): ${s.buyer.stateCode ?? s.seller.stateCode}`, 340, y + 111, 219, 'right');
    return y + 145;
  };
  const columns = (y: number): number => {
    doc.rect(36, y - 3, 523, 16).fill('#eee').fillColor('#000').font('Helvetica-Bold').fontSize(8);
    for (const c of COLS) text(c.label, c.x, y, c.w, c.align);
    doc.font('Helvetica').fontSize(9);
    return y + 18;
  };

  watermark();
  let y = columns(header(36));
  for (const l of s.lines) {
    if (y > 740) { doc.addPage(); watermark(); y = columns(36); }
    doc.fillColor('#000');
    text(`${l.name} (${l.sku})`, COLS[0].x, y, COLS[0].w); text(l.hsnCode ?? '-', COLS[1].x, y, COLS[1].w, 'left'); text(String(l.quantity), COLS[2].x, y, COLS[2].w, 'right');
    text(inr(l.taxableCents), COLS[3].x, y, COLS[3].w, 'right'); text(`${l.gstRateBp / 100}%`, COLS[4].x, y, COLS[4].w, 'right');
    text(inr(l.taxCents), COLS[5].x, y, COLS[5].w, 'right'); text(inr(l.taxableCents + l.taxCents), COLS[6].x, y, COLS[6].w, 'right');
    y += 16;
  }

  const t = s.totals;
  if (y > 640) { doc.addPage(); watermark(); y = 36; }
  doc.moveTo(300, y + 2).lineTo(559, y + 2).strokeColor('#999').stroke();
  y += 10;
  const row = (label: string, value: string, bold = false) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9); text(label, 300, y, 150); text(value, 450, y, 109, 'right'); y += bold ? 20 : 14; };
  row('Taxable value', inr(t.taxableCents));
  if (t.interState) row('IGST', inr(t.igstCents)); else { row('CGST', inr(t.cgstCents)); row('SGST', inr(t.sgstCents)); }
  row('Total', inr(t.totalCents), true);
  doc.font('Helvetica').fontSize(9);
  if (s.currency === 'INR') { doc.text(`Amount in words: ${pdfSafe(amountInWords(t.totalCents), 300)}`, 36, y + 6, { width: 523 }); }
  doc.fontSize(8).fillColor('#666').text('Prices include GST. This is a computer-generated invoice and needs no signature.', 36, 790, { width: 523, align: 'center', lineBreak: false });
  doc.end();
  return done;
}
