import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** WCAG 2.2 contrast (1.4.3 text 4.5:1, 1.4.11 non-text 3:1), computed from the design tokens in styles.css for BOTH colour schemes. */
// (Vitest turns CSS imports into empty modules, so read the file itself. The tests run from the web package or from the repository root.)
const cssPath = ['src/styles.css', 'src/web/src/styles.css'].map((p) => resolve(process.cwd(), p)).find((p) => existsSync(p))!;
const css = readFileSync(cssPath, 'utf8');
const block = (re: RegExp) => Object.fromEntries([...(re.exec(css)?.[1] ?? '').matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
const light = block(/:root\s*\{([^}]*)\}/);
const dark = { ...light, ...block(/prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/) };

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a: string, b: string): number => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
// Soft, tinted backgrounds are blended over the page surface, so check against the real colour they produce.
const mix = (fg: string, bg: string, alpha: number) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('');

describe.each([['light', light], ['dark', dark]] as const)('colour contrast (%s)', (_name, c) => {
  const text: [string, string, string][] = [
    ['body text', 'text', 'bg'], ['text on cards', 'text', 'surface'], ['muted text on page', 'muted', 'bg'], ['muted text on cards', 'muted', 'surface'],
    ['button label on brand', 'brand-ink', 'brand'], ['brand text on page', 'brand', 'bg'], ['brand text on cards', 'brand', 'surface'], ['text on soft brand', 'text', 'brand-soft'],
    ['good text on cards', 'good', 'surface'], ['warning text on cards', 'warn', 'surface'], ['error text on cards', 'bad', 'surface'], ['info text on cards', 'info', 'surface'],
  ];
  it.each(text)('%s is at least 4.5:1', (_label, fg, bg) => { expect(ratio(c[fg]!, c[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5); });

  it('badge tints (status colour at 15 % over the card, as in .badge) keep their text at 4.5:1', () => {
    for (const k of ['good', 'warn', 'bad', 'info']) expect(ratio(c[k]!, mix(c[k]!, c.surface!, 0.15)), k).toBeGreaterThanOrEqual(4.5);
  });
  it('control borders and focus rings are at least 3:1 against what they sit on (1.4.11)', () => {
    expect(ratio(c.brand!, c.surface!)).toBeGreaterThanOrEqual(3);          // focus ring
    expect(ratio(c.brand!, c.bg!)).toBeGreaterThanOrEqual(3);
  });
  it('the tokens were actually read', () => { expect(Object.keys(c).length).toBeGreaterThan(10); expect(c.text).toMatch(/^#/); });
});

describe('the two schemes are different', () => { it('dark is not light', () => { expect(dark.bg).not.toBe(light.bg); expect(dark.text).not.toBe(light.text); }); });
