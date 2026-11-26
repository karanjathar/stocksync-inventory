/**
 * Text of an UNCOMPRESSED pdfkit document with embedded (Identity-H) fonts: glyph ids in the page are translated back to Unicode
 * through each font's /ToUnicode map, so a test can assert on what a person would read.
 */
export function pdfText(buf: Buffer): string {
  const pdf = buf.toString('latin1');
  const object = (n: string) => pdf.match(new RegExp(`(?:^|\\n)${n} 0 obj([\\s\\S]*?)endobj`))?.[1] ?? '';
  const fontMaps = new Map<string, Map<number, string>>();
  for (const [, name, objNo] of pdf.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const cmapNo = object(objNo!).match(/\/ToUnicode (\d+) 0 R/)?.[1];
    if (!cmapNo) continue;
    const cmap = object(cmapNo);
    const map = new Map<number, string>();
    // A glyph can stand for several code points (a ligature): the map holds UTF-16 units, four hex digits each.
    const uni = (hex: string) => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((u) => parseInt(u, 16)));
    for (const [, start, , list] of cmap.matchAll(/<([0-9a-f]{4})>\s*<([0-9a-f]{4})>\s*\[([^\]]*)\]/g)) {
      [...list!.matchAll(/<([0-9a-f\s]+)>/g)].forEach((m, i) => map.set(parseInt(start!, 16) + i, uni(m[1]!.replace(/\s+/g, ''))));
    }
    for (const [, gid, u] of cmap.matchAll(/^<([0-9a-f]{4})>\s*<([0-9a-f\s]+)>$/gm)) map.set(parseInt(gid!, 16), uni(u!.replace(/\s+/g, '')));
    fontMaps.set(name!, map);
  }
  // Walk the page content: a run of text is one Tm (position), Tf (font) and TJ (glyphs). Runs that sit on the same baseline
  // belong to one printed line (a Latin run followed by a Devanagari run, for instance) and are joined in reading order.
  const lines: string[] = [];
  let font = ''; let x = 0; let y = Number.NaN; let lastY = Number.NaN; let lastX = -1;
  for (const m of pdf.matchAll(/\/(F\d+) [\d.]+ Tf|1 0 0 1 ([\d.-]+) ([\d.-]+) Tm|\[((?:<[0-9a-f]*>[\s\d.-]*)+)\] TJ/g)) {
    if (m[1]) { font = m[1]; continue; }
    if (m[2]) { x = Number(m[2]); y = Number(m[3]); continue; }
    const map = fontMaps.get(font);
    if (!map) continue;
    const piece = [...m[4]!.matchAll(/<([0-9a-f]*)>/g)].map((h) => (h[1]!.match(/.{4}/g) ?? []).map((g) => map.get(parseInt(g, 16)) ?? '').join('')).join('');
    if (lines.length && Math.abs(y - lastY) < 0.05 && x >= lastX) lines[lines.length - 1] += piece; else lines.push(piece);
    lastY = y; lastX = x;
  }
  return lines.join('\n');
}
