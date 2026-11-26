// Fails the build when the web app's JavaScript grows past the budget (sizes are gzip, which is what travels over the network).
// "Initial" = the entry script plus everything index.html preloads: what a visitor must download before the first screen can appear.
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const BUDGET = { initialKb: 100, routeChunkKb: 15, totalKb: 170 };   // reference build: initial ≈ 90, largest route chunk ≈ 7, total ≈ 135
const dist = path.resolve(process.argv[2] ?? 'src/web/dist');
const kb = (file) => gzipSync(readFileSync(path.join(dist, file)), { level: 9 }).length / 1024;
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const initialFiles = [...new Set([...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]))];
const all = readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`);
const sizes = Object.fromEntries(all.map((f) => [f, kb(f)]));
const initial = initialFiles.reduce((n, f) => n + (sizes[f] ?? 0), 0);
const routeChunks = all.filter((f) => !initialFiles.includes(f));
const biggest = routeChunks.map((f) => [f, sizes[f]]).sort((a, b) => b[1] - a[1])[0] ?? ['(none)', 0];
const total = Object.values(sizes).reduce((a, b) => a + b, 0);

const rows = [
  ['initial JavaScript (entry + preloads)', initial, BUDGET.initialKb],
  [`largest route chunk (${biggest[0]})`, biggest[1], BUDGET.routeChunkKb],
  ['all JavaScript', total, BUDGET.totalKb],
];
let failed = false;
for (const [label, value, limit] of rows) {
  const ok = value <= limit; failed ||= !ok;
  console.log(`${ok ? '✔' : '✘'} ${label}: ${value.toFixed(1)} KB gzip (budget ${limit} KB)`);
}
if (routeChunks.length < 5) { failed = true; console.log('✘ expected route-level code splitting (at least 5 separate route chunks)'); }
if (failed) { console.error('Bundle budget exceeded: split the code, drop a dependency, or raise the budget deliberately in scripts/check-bundle.mjs.'); process.exit(1); }
