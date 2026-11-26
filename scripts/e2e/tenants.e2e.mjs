#!/usr/bin/env node
// End-to-end test of Release 5 (many businesses on one installation) against the PRODUCTION build, with a real browser:
//   A. Two businesses sign up through the website, confirm their e-mail address (the mail arrives at a fake Azure Communication Services endpoint,
//      so the real e-mail adapter is exercised), sign in, and each adds a product.
//   B. Each business's public shop shows only its own product; a shopper places a first order in one of them.
//   C. Isolation: the other business never sees that order or product, by the website or by the API (404, not 403); a made-up shop is a plain 404.
//   D. Sessions: cookies are httpOnly, nothing is stored in localStorage, a change without the CSRF token is refused, signing out ends the session.
//
// Run:   npm run build && node scripts/e2e/tenants.e2e.mjs        (also part of: npm run e2e)
// Needs: PostgreSQL (E2E_DATABASE_URL, default postgres://postgres@localhost:5432/inventory_e2e_tenants — recreated each run) and Playwright with Chromium.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'scripts/e2e/out');
function need(name) { try { return require(name); } catch { console.error(`E2E needs "${name}". Install it with:  npm i -D playwright pg && npx playwright install chromium`); process.exit(2); } }
const { chromium } = need('playwright');
const pg = need('pg');

const APP_PORT = Number(process.env.E2E_PORT ?? 18080);
const APP = `http://127.0.0.1:${APP_PORT}`;
const BASE_DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@localhost:5432/inventory_e2e';
const DB_NAME = 'inventory_e2e_tenants';
const DB_URL = (() => { const u = new URL(BASE_DB); u.pathname = `/${DB_NAME}`; return u.toString(); })();
const PASSWORD = 'Tenant-E2e-Pass-1';

const ok = (msg) => console.log(`  ✔ ${msg}`);
function check(cond, msg) { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); ok(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await sleep(150); }
}

async function recreateDatabase() {
  const admin = new URL(DB_URL); admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${DB_NAME}`);
  await client.end();
}

/** A stand-in for Azure Communication Services Email: records what the app sends. */
function startFakeEmail() {
  const mails = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.startsWith('/emails:send') && req.headers.authorization?.startsWith('HMAC-SHA256 ')) {
        const m = JSON.parse(body);
        mails.push({ to: m.recipients.to[0].address, subject: m.content.subject, text: m.content.plainText });
        res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
      } else res.writeHead(400).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ mails, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

async function main() {
  for (const f of ['src/api/dist/index.js', 'src/web/dist/index.html']) if (!existsSync(path.join(ROOT, f))) throw new Error(`${f} is missing — run "npm run build" first`);
  mkdirSync(OUT, { recursive: true });
  await recreateDatabase();
  const email = await startFakeEmail();

  let serverLog = '';
  const server = spawn(process.execPath, ['src/api/dist/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(APP_PORT), PUBLIC_BASE_URL: APP, DATABASE_URL: DB_URL, DATABASE_SSL: 'false',
      JWT_SECRET: 'e2e-tenants-jwt-secret-0123456789-abcdef', TENANT_FALLBACK: 'off', SIGNUP_ENABLED: 'true',
      ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
      EMAIL_CONNECTION_STRING: `endpoint=${email.url};accesskey=${Buffer.alloc(32, 5).toString('base64')}`, EMAIL_FROM: 'noreply@e2e.test',
      ADMIN_EMAIL: '', ADMIN_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (d) => { serverLog = (serverLog + d).slice(-6000); });
  let browser;

  try {
    await waitFor(async () => { try { return (await fetch(`${APP}/healthz`)).ok; } catch { return false; } }, 'the server to start');
    console.log(`Server up at ${APP} (sign-up open, no single-business fallback)`);
    browser = await chromium.launch();
    const consoleErrors = [];

    /** A fresh browser profile for one business owner. */
    async function owner() {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${page.url()}`); });
      page.on('pageerror', (e) => consoleErrors.push(String(e)));
      return { context, page };
    }
    /** An API call made BY the signed-in page (cookies and the CSRF header exactly as the app does it). */
    const api = (page, method, p, body) => page.evaluate(async ({ method, p, body }) => {
      const csrf = /(?:^|; )ss_csrf=([^;]+)/.exec(document.cookie)?.[1];
      const res = await fetch(`/api${p}`, { method, headers: { 'content-type': 'application/json', ...(csrf && method !== 'GET' ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    }, { method, p, body });

    async function signUpAndIn({ page }, { business, slug, name, mail }) {
      await page.goto(`${APP}/signup`);
      await page.getByLabel('Business name').fill(business);
      await page.getByLabel('Web address').fill(slug);
      await page.getByLabel('Your name').fill(name);
      await page.getByLabel('Email').fill(mail);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByText('Check your email').waitFor();
      const message = await waitFor(() => email.mails.find((m) => m.to === mail), `the confirmation e-mail for ${mail}`);
      const link = /(https?:\/\/[^\s]+\/verify-email\?token=[\w-]+)/.exec(message.text)?.[1];
      check(Boolean(link), `a confirmation link was e-mailed to ${mail} (through the e-mail adapter)`);
      const before = (await pgCount(`SELECT count(*) FROM tenants WHERE slug = '${slug}'`));
      check(before === 0, `${business} does not exist yet: nothing is created before the e-mail is confirmed`);
      await page.goto(link);
      await page.getByText("You're all set").waitFor();
      check((await pgCount(`SELECT count(*) FROM tenants WHERE slug = '${slug}'`)) === 1, `${business} was created by the confirmation link`);
      await page.goto(`${APP}/login`);
      await page.getByLabel('Email').fill(mail);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${APP}/`);
      await page.getByText(business).first().waitFor();
      ok(`${name} signed in to ${business}`);
    }
    const db = new pg.Client({ connectionString: DB_URL }); await db.connect();
    const pgCount = async (sql) => Number((await db.query(sql)).rows[0].count);

    // ---- A. two businesses sign up --------------------------------------------------------------------------------------------------------
    console.log('\nA. Sign-up and first sign-in');
    const a = await owner(); const b = await owner();
    await signUpAndIn(a, { business: 'Alpha Traders', slug: 'alpha', name: 'Asha', mail: 'asha@alpha.test' });
    await signUpAndIn(b, { business: 'Beta Bazaar', slug: 'beta', name: 'Bilal', mail: 'bilal@beta.test' });

    for (const [who, label, sku, productName, price] of [[a, 'Alpha', 'ALPHA-TEE', 'Alpha Tee', 49900], [b, 'Beta', 'BETA-MUG', 'Beta Mug', 25000]]) {
      const wh = await api(who.page, 'POST', '/warehouses', { code: 'MAIN', name: 'Main' });
      const product = await api(who.page, 'POST', '/products', { sku, name: productName, priceCents: price });
      const received = await api(who.page, 'POST', '/stock/receive', { productId: product.body.id, warehouseId: wh.body.id, quantity: 10 });
      await api(who.page, 'PUT', '/settings', { currency: 'INR', defaultWarehouseId: wh.body.id });
      check(wh.status === 201 && product.status === 201 && received.status < 300, `${label} added its warehouse, product and stock`);
      who.product = product.body.id; who.sku = sku; who.name = productName;
    }

    // ---- B. public shops and a first order --------------------------------------------------------------------------------------------------
    console.log('\nB. Each business has its own shop');
    const shopper = await owner();
    await shopper.page.goto(`${APP}/shop/alpha`);
    await shopper.page.getByText('Alpha Tee').first().waitFor();
    check((await shopper.page.getByText('Beta Mug').count()) === 0, 'the Alpha shop shows Alpha\'s product and nothing of Beta\'s');
    await shopper.page.getByRole('button', { name: 'Add Alpha Tee to cart' }).click();
    await shopper.page.getByLabel('Your name').fill('Priya Shopper');
    await shopper.page.getByLabel('Phone (WhatsApp)').fill('+919876500001');
    await shopper.page.getByRole('button', { name: 'Place order' }).click();
    await shopper.page.waitForURL(/\/shop\/order\//);
    ok('a shopper placed a first order in the Alpha shop (cash on delivery) and reached its status page');
    const beta = await owner();
    await beta.page.goto(`${APP}/shop/beta`);
    await beta.page.getByText('Beta Mug').first().waitFor();
    check((await beta.page.getByText('Alpha Tee').count()) === 0, 'the Beta shop shows Beta\'s product and nothing of Alpha\'s');
    const missing = await fetch(`${APP}/api/public/s/no-such-shop/catalog`);
    const suspendedLike = await fetch(`${APP}/api/public/s/${'x'.repeat(41)}/catalog`);
    check(missing.status === 404 && suspendedLike.status === 404, 'an unknown shop address is a plain 404');

    // ---- C. isolation ---------------------------------------------------------------------------------------------------------------------
    console.log('\nC. Isolation between businesses');
    await a.page.goto(`${APP}/orders`);
    await a.page.getByText('Priya Shopper').first().waitFor();
    ok('Alpha sees the shopper\'s order in its Orders page');
    const aOrders = await api(a.page, 'GET', '/orders');
    const bOrders = await api(b.page, 'GET', '/orders');
    check(aOrders.body.length === 1 && bOrders.body.length === 0, 'Beta has no orders: Alpha\'s order is invisible to it');
    const mark = consoleErrors.length;   // the next requests are refused ON PURPOSE; the browser logs each refusal, which is not a defect
    const peek = await api(b.page, 'GET', `/orders/${aOrders.body[0].id}`);
    const peekProduct = await api(b.page, 'GET', `/products/${a.product}`);
    const nothing = await api(b.page, 'GET', '/orders/00000000-0000-4000-8000-0000000000ff');
    consoleErrors.length = mark;
    check(peek.status === 404 && peekProduct.status === 404 && JSON.stringify(peek.body) === JSON.stringify(nothing.body), 'Beta asking for Alpha\'s order or product gets the same 404 as for something that does not exist');
    const bProducts = await api(b.page, 'GET', '/products');
    check(bProducts.body.length === 1 && bProducts.body[0].sku === 'BETA-MUG', 'Beta\'s product list holds only Beta\'s product');
    const dup = await api(b.page, 'POST', '/products', { sku: 'ALPHA-TEE', name: 'Same SKU, different business', priceCents: 1 });
    check(dup.status === 201, 'two businesses may use the same SKU (numbering and uniqueness are per business)');

    // ---- D. sessions ----------------------------------------------------------------------------------------------------------------------
    console.log('\nD. Sessions');
    const cookies = await a.context.cookies();
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
    check(byName.ss_access?.httpOnly && byName.ss_refresh?.httpOnly && byName.ss_access.sameSite === 'Strict' && !byName.ss_csrf?.httpOnly, 'the session cookies are httpOnly and SameSite=Strict (only the CSRF cookie is readable by the page)');
    check(await a.page.evaluate(() => Object.keys(localStorage).every((k) => !/token|jwt|session/i.test(k))), 'no token is kept in localStorage');
    const mark2 = consoleErrors.length;
    const noCsrf = await a.page.evaluate(async () => (await fetch('/api/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"sneaky"}' })).status);
    consoleErrors.length = mark2;
    check(noCsrf === 403, 'a change made without the CSRF token is refused');
    await a.page.getByRole('button', { name: 'Sign out' }).click();
    await a.page.waitForURL(/\/login/);
    const mark3 = consoleErrors.length;
    const after = await a.page.evaluate(async () => (await fetch('/api/orders')).status);
    consoleErrors.length = mark3;
    check(after === 401, 'after signing out, the old session no longer works');

    const wait = 200; await sleep(wait);
    check(consoleErrors.length === 0, `no browser console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
    await db.end();
    console.log('\nE2E TENANTS PASSED');
  } catch (err) {
    console.error(`\n✘ ${err.message}\n\n--- last server log ---\n${serverLog.slice(-2500)}`);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill('SIGTERM');
    email.close();
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref?.();   // open handles (database client, keep-alive sockets) must not keep a finished run alive
}

main().catch((err) => { console.error(err); process.exit(1); });
