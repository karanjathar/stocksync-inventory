import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { amountInWords } from './amountInWords.js';
import type { Invoice } from './invoices.js';

const require = createRequire(import.meta.url);

/**
 * Plain-text clean-up for any PDF text: control characters are dropped and line breaks and tabs collapse to one space.
 * With `latin1Only` (the Helvetica fallback) anything outside Latin-1 becomes "?".
 */
export function pdfSafe(text: string, max = 200, latin1Only = true): string {
  let out = '';
  let lastWasBreak = false;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a || c === 0x0d || c === 0x09) { if (!lastWasBreak) out += ' '; lastWasBreak = true; continue; }
    lastWasBreak = false;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    out += !latin1Only || (c <= 0x7e) || (c >= 0xa0 && c <= 0xff) ? ch : '?';
  }
  return Array.from(out).slice(0, max).join('');
}

/** 1234567 paise → "Rs. 12,345.67" with Indian digit grouping (symbol "₹" when the font has it). */
export function inr(cents: number, symbol = 'Rs. '): string {
  const whole = Math.floor(cents / 100).toString();
  const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  return `${symbol}${grouped}.${String(cents % 100).padStart(2, '0')}`;
}

const istDate = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso)).replace(/\//g, '-');

/** Noto Sans (Latin) and Noto Sans Devanagari (Hindi and the rupee sign), SIL OFL 1.1, from the @fontsource packages. Null when not installed. */
interface FontFiles { latin: string; latinBold: string; deva: string; devaBold: string }
let fontFiles: FontFiles | null | undefined;
function fonts(): FontFiles | null {
  if (fontFiles !== undefined) return fontFiles;
  try {
    const dir = (pkg: string) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files');
    const l = dir('@fontsource/noto-sans'); const d = dir('@fontsource/noto-sans-devanagari');
    const f: FontFiles = {
      latin: path.join(l, 'noto-sans-latin-400-normal.woff'), latinBold: path.join(l, 'noto-sans-latin-700-normal.woff'),
      deva: path.join(d, 'noto-sans-devanagari-devanagari-400-normal.woff'), devaBold: path.join(d, 'noto-sans-devanagari-devanagari-700-normal.woff'),
    };
    fontFiles = Object.values(f).every((p) => existsSync(p)) ? f : null;
  } catch { fontFiles = null; }
  return fontFiles;
}

const COLS = [
  { label: 'Item', x: 36, w: 178, align: 'left' }, { label: 'HSN/SAC', x: 218, w: 50, align: 'left' },
  { label: 'Qty', x: 270, w: 28, align: 'right' }, { label: 'Taxable value', x: 300, w: 78, align: 'right' },
  { label: 'GST', x: 380, w: 36, align: 'right' }, { label: 'Tax', x: 418, w: 64, align: 'right' },
  { label: 'Amount', x: 484, w: 75, align: 'right' },
] as const;

type Align = 'left' | 'right' | 'center';
interface Run { text: string; font: 'latin' | 'deva' }

/** Renders an issued invoice (from its immutable snapshot) as an A4 PDF. `compress:false` is for tests. */
export function renderInvoicePdf(invoice: Invoice, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const s = invoice.snapshot;
  const doc = new PDFDocument({ size: 'A4', margin: 36, compress: opts.compress ?? true, info: { Title: `Tax invoice ${pdfSafe(invoice.number, 80)}`, Producer: 'StockSync' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const f = fonts();
  if (f) { doc.registerFont('L', f.latin); doc.registerFont('LB', f.latinBold); doc.registerFont('D', f.deva); doc.registerFont('DB', f.devaBold); }
  const face = (font: Run['font'], bold: boolean) => (f ? (font === 'latin' ? (bold ? 'LB' : 'L') : (bold ? 'DB' : 'D')) : (bold ? 'Helvetica-Bold' : 'Helvetica'));
  // pdfkit exposes the loaded font object only privately; the tests below fail loudly if a pdfkit upgrade changes it.
  const hasGlyph = (font: Run['font'], cp: number): boolean => {
    if (!f) return font === 'latin' && ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff));
    doc.font(face(font, false));
    return (doc as unknown as { _font: { font: { hasGlyphForCodePoint(c: number): boolean } } })._font.font.hasGlyphForCodePoint(cp);
  };
  /** Ascender in 1/1000 em. Two fonts put their baseline at different heights for the same y, so runs are shifted to share one baseline. */
  const ascent = (font: Run['font']): number => {
    if (!f) return 0;
    doc.font(face(font, false));
    return (doc as unknown as { _font: { ascender: number } })._font.ascender;
  };
  const symbol = f && hasGlyph('deva', 0x20b9) ? '₹' : 'Rs. ';
  const money = (cents: number) => inr(cents, symbol);

  let bold = false; let size = 9;
  const style = (b: boolean, sz: number) => { bold = b; size = sz; };
  /** Splits text into runs per script: Latin font where it has the character, otherwise Devanagari, otherwise "?". */
  const runsOf = (raw: string, max = 300): Run[] => {
    const runs: Run[] = [];
    for (const ch of pdfSafe(raw, max, false)) {
      const cp = ch.codePointAt(0)!;
      let font: Run['font'] = 'latin'; let out = ch;
      if (!hasGlyph('latin', cp)) { if (hasGlyph('deva', cp)) font = 'deva'; else out = '?'; }
      const last = runs[runs.length - 1];
      if (last && (last.font === font || (cp === 0x20 && last.font !== font))) last.text += out; else runs.push({ text: out, font });
    }
    return runs;
  };
  const measure = (runs: Run[]) => runs.reduce((w, r) => w + doc.font(face(r.font, bold)).fontSize(size).widthOfString(r.text), 0);
  /** One line of text at (x, y) inside `width`, aligned, shortened with "..." if too wide. Never wraps. */
  const put = (raw: string, x: number, y: number, width: number, align: Align = 'left') => {
    let runs = runsOf(raw);
    if (measure(runs) > width) {
      const chars = Array.from(runs.map((r) => r.text).join(''));
      while (chars.length > 1 && measure(runsOf(`${chars.join('')}...`)) > width) chars.pop();
      runs = runsOf(`${chars.join('')}...`);
    }
    const w = measure(runs);
    let cx = align === 'right' ? x + width - w : align === 'center' ? x + (width - w) / 2 : x;
    for (const r of runs) {
      const dy = ((ascent('latin') - ascent(r.font)) * size) / 1000;
      doc.font(face(r.font, bold)).fontSize(size).text(r.text, cx, y + dy, { lineBreak: false });
      cx += doc.widthOfString(r.text);
    }
  };
  /** Greedy word wrap into at most `maxLines` lines, each drawn with put(). Returns the lines used. */
  const wrap = (raw: string, x: number, y: number, width: number, maxLines: number, lineHeight = 12): number => {
    const words = pdfSafe(raw, 600, false).split(' ').filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (measure(runsOf(next)) <= width || !cur) cur = next; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    lines.slice(0, maxLines).forEach((l, i) => put(i === maxLines - 1 && lines.length > maxLines ? `${l}...` : l, x, y + i * lineHeight, width));
    return Math.min(lines.length, maxLines);
  };

  const watermark = () => {
    if (invoice.status !== 'VOID') return;
    doc.save().fillColor('#d33', 0.18).font(face('latin', true)).fontSize(110).rotate(-30, { origin: [300, 420] }).text('VOID', 150, 380, { lineBreak: false }).restore();
  };
  const header = (y: number): number => {
    doc.fillColor('#000'); style(true, 16); put('TAX INVOICE', 36, y, 300);
    style(false, 9);
    put(`Invoice No: ${s.number}`, 340, y, 219, 'right'); put(`Date: ${istDate(s.issuedAt)}`, 340, y + 13, 219, 'right'); put(`Order #${s.order.number}`, 340, y + 26, 219, 'right');
    style(true, 11); put(s.seller.legalName, 36, y + 30, 290);
    style(false, 9); wrap(s.seller.address, 36, y + 45, 290, 2);
    put(`GSTIN: ${s.seller.gstin}   State code: ${s.seller.stateCode}`, 36, y + 72, 290);
    doc.moveTo(36, y + 90).lineTo(559, y + 90).strokeColor('#999').stroke();
    style(true, 9); put('Bill to', 36, y + 98, 100); style(false, 9);
    put(s.buyer.name, 36, y + 111, 290);
    if (s.buyer.gstin) put(`GSTIN: ${s.buyer.gstin}`, 36, y + 124, 290);
    put(`Place of supply (state code): ${s.buyer.stateCode ?? s.seller.stateCode}`, 340, y + 111, 219, 'right');
    return y + 145;
  };
  const columns = (y: number): number => {
    doc.rect(36, y - 3, 523, 16).fill('#eee').fillColor('#000'); style(true, 8);
    for (const c of COLS) put(c.label, c.x, y, c.w, c.align);
    style(false, 9);
    return y + 18;
  };

  watermark();
  let y = columns(header(36));
  for (const l of s.lines) {
    if (y > 740) { doc.addPage(); watermark(); y = columns(36); }
    doc.fillColor('#000'); style(false, 9);
    put(`${l.name} (${l.sku})`, COLS[0].x, y, COLS[0].w); put(l.hsnCode ?? '-', COLS[1].x, y, COLS[1].w); put(String(l.quantity), COLS[2].x, y, COLS[2].w, 'right');
    put(money(l.taxableCents), COLS[3].x, y, COLS[3].w, 'right'); put(`${l.gstRateBp / 100}%`, COLS[4].x, y, COLS[4].w, 'right');
    put(money(l.taxCents), COLS[5].x, y, COLS[5].w, 'right'); put(money(l.taxableCents + l.taxCents), COLS[6].x, y, COLS[6].w, 'right');
    y += 16;
  }

  const t = s.totals;
  if (y > 640) { doc.addPage(); watermark(); y = 36; }
  doc.moveTo(300, y + 2).lineTo(559, y + 2).strokeColor('#999').stroke();
  y += 10;
  const row = (label: string, value: string, strong = false) => { style(strong, strong ? 11 : 9); put(label, 300, y, 150); put(value, 450, y, 109, 'right'); y += strong ? 20 : 14; };
  row('Taxable value', money(t.taxableCents));
  if (t.interState) row('IGST', money(t.igstCents)); else { row('CGST', money(t.cgstCents)); row('SGST', money(t.sgstCents)); }
  row('Total', money(t.totalCents), true);
  style(false, 9);
  if (s.currency === 'INR') wrap(`Amount in words: ${amountInWords(t.totalCents)}`, 36, y + 6, 523, 2);
  style(false, 8); doc.fillColor('#666');
  put('Prices include GST. This is a computer-generated invoice and needs no signature.', 36, 790, 523, 'center');
  doc.end();
  return done;
}
