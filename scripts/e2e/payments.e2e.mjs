#!/usr/bin/env node
// End-to-end test of Release 2 against the PRODUCTION build, with a real browser:
//   A. Website: shop → "Pay online" → (fake) Razorpay page → signed webhook → order status page shows paid & confirmed.
//   B. WhatsApp: tap-through bot conversation via signed Meta webhooks → pay link → pay → "payment received" message.
//   C. Security: forged payment webhooks are rejected.
//
// Run:   npm run build && node scripts/e2e/payments.e2e.mjs        (or: npm run e2e)
// Needs: PostgreSQL (E2E_DATABASE_URL, default postgres://postgres@localhost:5432/inventory_e2e — recreated each run)
//        Playwright with Chromium (npm i -D playwright && npx playwright install chromium)
// Third-party APIs are replaced by local fakes (scripts/e2e/fakes.mjs): this proves OUR flows end to end,
// not Razorpay's or Meta's real behaviour.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeMeta, startFakeRazorpay } from './fakes.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'scripts/e2e/out');

function need(name) {
  try { return require(name); } catch {
    console.error(`E2E needs "${name}". Install it with:  npm i -D playwright pg && npx playwright install chromium`);
    process.exit(2);
  }
}
const { chromium } = need('playwright');
const pg = need('pg');

const APP_PORT = Number(process.env.E2E_PORT ?? 18080);
const APP = `http://127.0.0.1:${APP_PORT}`;
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@localhost:5432/inventory_e2e';
const DB_NAME = new URL(DB_URL).pathname.slice(1);
const S = {
  jwt: 'e2e-jwt-secret-0123456789-0123456789-abcdef',
  adminEmail: 'admin@e2e.test', adminPassword: 'E2e-Admin-Pass-1',
  rzpKeyId: 'rzp_test_e2e', rzpKeySecret: 'e2e-key-secret', rzpWebhookSecret: 'e2e-webhook-secret',
  metaAppSecret: 'e2e-meta-app-secret', metaVerify: 'e2e-verify',
};

const steps = [];
const ok = (msg) => { steps.push(msg); console.log(`  ✔ ${msg}`); };
function check(cond, msg) { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); ok(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

async function recreateDatabase() {
  if (!/^[a-z0-9_]+$/.test(DB_NAME)) throw new Error(`Refusing to recreate database "${DB_NAME}" (letters, digits and _ only)`);
  const admin = new URL(DB_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${DB_NAME}`);
  await client.end();
}

async function main() {
  for (const f of ['src/api/dist/index.js', 'src/web/dist/index.html']) {
    if (!existsSync(path.join(ROOT, f))) throw new Error(`${f} is missing — run "npm run build" first`);
  }
  mkdirSync(OUT, { recursive: true });
  await recreateDatabase();
  console.log(`Database ${DB_NAME} recreated`);

  const razorpay = await startFakeRazorpay({
    keyId: S.rzpKeyId, keySecret: S.rzpKeySecret, webhookSecret: S.rzpWebhookSecret, webhookUrl: `${APP}/webhooks/razorpay`,
  });
  const meta = await startFakeMeta();

  let serverLog = '';
  const server = spawn(process.execPath, ['src/api/dist/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production', PORT: String(APP_PORT), PUBLIC_BASE_URL: APP,
      DATABASE_URL: DB_URL, DATABASE_SSL: 'false', JWT_SECRET: S.jwt, ADMIN_EMAIL: S.adminEmail, ADMIN_PASSWORD: S.adminPassword,
      RAZORPAY_KEY_ID: S.rzpKeyId, RAZORPAY_KEY_SECRET: S.rzpKeySecret, RAZORPAY_WEBHOOK_SECRET: S.rzpWebhookSecret, RAZORPAY_API_BASE: razorpay.url,
      META_APP_SECRET: S.metaAppSecret, META_VERIFY_TOKEN: S.metaVerify, META_GRAPH_BASE: meta.url,
      WHATSAPP_TOKEN: 'e2e-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (d) => { serverLog = (serverLog + d).slice(-6000); });
  let browser;

  try {
    await waitFor(async () => { try { return (await fetch(`${APP}/healthz`)).ok; } catch { return false; } }, 'the server to start');
    console.log(`Server up at ${APP}`);

    // ---- seed through the real API ---------------------------------------------------------
    const call = async (method, pathname, body, token) => {
      const res = await fetch(`${APP}${pathname}`, {
        method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const login = await call('POST', '/api/auth/login', { email: S.adminEmail, password: S.adminPassword });
    const token = login.body.token;
    const admin = (method, p, body) => call(method, p, body, token).then((r) => { if (r.status >= 300) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; });
    const wh = await admin('POST', '/api/warehouses', { code: 'MAIN', name: 'Main' });
    await admin('PUT', '/api/settings', { currency: 'INR', businessName: 'E2E Shop', whatsappNumber: '919000000000', defaultWarehouseId: wh.id });
    const cat = await admin('POST', '/api/categories', { name: 'Apparel' });
    const tee = await admin('POST', '/api/products', { sku: 'TEE', name: 'Red Tee', priceCents: 49900, categoryId: cat.id });
    await admin('POST', '/api/stock/receive', { productId: tee.id, warehouseId: wh.id, quantity: 20, reason: 'E2E opening stock' });
    const stock = async () => (await admin('GET', `/api/stock?productId=${tee.id}`))[0].quantity;
    const cfg = await admin('GET', '/api/payments/config');
    check(cfg.onlineAvailable === true, 'online payments are available (keys configured, INR)');

    // ---- C. forged webhooks ----------------------------------------------------------------
    console.log('\nC. Webhook security');
    const forged = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_E2E1', amount_paid: 1 } } } });
    const bad = await fetch(`${APP}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' }, body: forged });
    check(bad.status === 401, 'a forged Razorpay webhook is rejected with 401');
    const badMeta = await fetch(`${APP}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
    check(badMeta.status === 401, 'a forged Meta webhook is rejected with 401');

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const consoleErrors = [];
    const track = (page) => { page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); }); page.on('pageerror', (e) => consoleErrors.push(String(e))); };

    // ---- A. website checkout ---------------------------------------------------------------
    console.log('\nA. Website: pay online');
    const page = await ctx.newPage();
    track(page);
    await page.goto(`${APP}/shop`);
    await page.getByRole('button', { name: 'Add Red Tee to cart' }).click();
    await page.getByRole('button', { name: 'Add Red Tee to cart' }).click();
    await page.getByLabel('Your name').fill('Mia Shopper');
    await page.getByLabel('Phone (WhatsApp)').fill('+919811100001');
    check(await page.getByLabel(/pay online/i).isChecked(), 'the shop offers "Pay online" first and preselects it');
    const stockBeforeA = await stock();
    await page.getByRole('button', { name: 'Place order' }).click();
    await page.waitForURL(/127\.0\.0\.1:\d+\/pay\/plink_E2E/, { timeout: 15_000 });
    check(true, 'the shopper is redirected to the Razorpay payment page');
    check((await page.textContent('body')).includes('₹998.00'), 'the payment page shows the server-computed amount (₹998.00)');
    check((await stock()) === stockBeforeA, 'stock is not deducted before payment');
    await page.getByRole('button', { name: 'Pay now' }).click();
    await page.waitForURL(/\/shop\/order\//, { timeout: 15_000 });
    check(page.url().includes('razorpay_payment_link_status=paid'), 'Razorpay sends the shopper back to the order page');
    await page.getByText(/payment received — your order is confirmed/i).waitFor({ timeout: 20_000 });
    check(true, 'the order page updates to "Payment received — your order is confirmed" (webhook → polling)');
    const ordersA = await admin('GET', '/api/orders');
    const orderA = ordersA.find((o) => o.channel === 'web');
    check(orderA?.status === 'CONFIRMED' && orderA.paymentStatus === 'PAID' && orderA.paymentMethod === 'ONLINE', 'the web order is CONFIRMED, PAID and ONLINE in the database');
    check((await stock()) === stockBeforeA - 2, 'stock was deducted exactly once (2 units)');
    await page.screenshot({ path: path.join(OUT, 'shop-order-paid.png') });

    // ---- B. WhatsApp tap flow --------------------------------------------------------------
    console.log('\nB. WhatsApp: tap-to-order and pay');
    const wa = '919811100002';
    let seq = 0;
    const sendMeta = async (message) => {
      const raw = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { contacts: [{ wa_id: wa, profile: { name: 'Ravi Buyer' } }], messages: [{ id: `wamid.E2E${++seq}`, from: wa, ...message }] } }] }],
      });
      const res = await fetch(`${APP}/webhooks/meta`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', S.metaAppSecret).update(raw).digest('hex')}` },
        body: raw,
      });
      if (res.status !== 200) throw new Error(`Meta webhook → ${res.status}`);
    };
    const toWa = () => meta.messages.filter((m) => m.body.to === wa);
    /** Sends something and returns the bot's next reply to this customer. */
    const converse = async (message) => {
      const before = toWa().length;
      await sendMeta(message);
      await waitFor(() => toWa().length > before, 'the bot to reply');
      return toWa().at(-1).body;
    };
    const say = (text) => converse({ type: 'text', text: { body: text } });
    const tapButton = (id) => converse({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });
    const tapRow = (id) => converse({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } } });
    const buttonIds = (b) => b.interactive?.action?.buttons?.map((x) => x.reply.id);
    const rowIds = (b) => b.interactive?.action?.sections?.flatMap((s) => s.rows.map((r) => r.id)) ?? [];

    let reply = await say('hi');
    check(JSON.stringify(buttonIds(reply)) === JSON.stringify(['catalog', 'cart', 'orders']), 'greeting shows the Browse / My cart / My orders buttons');
    reply = await tapButton('catalog');
    check(reply.interactive?.type === 'list', 'Browse shows a list message');
    while (rowIds(reply)[0]?.startsWith('cat:')) reply = await tapRow(rowIds(reply)[0]);
    const prodRow = rowIds(reply).find((id) => id === `prod:${tee.id}`);
    check(Boolean(prodRow), 'the product list contains "Red Tee"');
    reply = await tapRow(prodRow);
    check(rowIds(reply).includes(`qty:${tee.id}:2`), 'the product card offers a quantity list');
    reply = await tapRow(`qty:${tee.id}:2`);
    check(JSON.stringify(buttonIds(reply)) === JSON.stringify(['checkout', 'catalog', 'cart:clear']), 'adding to the cart offers Checkout / Keep shopping / Clear cart');
    reply = await tapButton('checkout');
    check(JSON.stringify(buttonIds(reply)) === JSON.stringify(['pay:online', 'pay:cod', 'cart']), 'checkout offers Pay online and Cash on delivery');
    const stockBeforeB = await stock();
    reply = await tapButton('pay:online');
    const cta = reply.interactive?.action?.parameters;
    check(reply.interactive?.type === 'cta_url' && cta?.display_text === 'Pay ₹998.00', 'Pay online replies with a "Pay ₹998.00" URL button');
    check(cta.url.startsWith(razorpay.url), 'the button opens the (fake) Razorpay payment page');

    const payPage = await ctx.newPage();
    track(payPage);
    await payPage.goto(cta.url);
    await payPage.getByRole('button', { name: 'Pay now' }).click();
    const confirmation = await waitFor(() => toWa().find((m) => m.body.text?.body?.includes('payment of ₹998.00 received')), 'the payment-received message');
    check(/order #\d+ is confirmed/i.test(confirmation.body.text.body), 'the customer gets ONE "payment received — order confirmed" message in WhatsApp');
    const orderB = (await admin('GET', '/api/orders')).find((o) => o.channel === 'whatsapp');
    check(orderB?.status === 'CONFIRMED' && orderB.paymentStatus === 'PAID', 'the WhatsApp order is CONFIRMED and PAID in the database');
    check((await stock()) === stockBeforeB - 2, 'stock was deducted exactly once (2 units)');
    const mine = await tapButton('orders');
    check(rowIds(mine).length === 1 && mine.interactive.action.sections[0].rows[0].title.includes('Confirmed'), 'My orders lists the order as Confirmed');
    await sleep(1500);
    check(toWa().filter((m) => m.body.text?.body?.includes('payment of')).length === 1, 'no duplicate payment messages after the webhook settles');

    // ---- dashboard sanity: payments visible to staff --------------------------------------
    const admPage = await ctx.newPage();
    track(admPage);
    await admPage.goto(`${APP}/login`);
    await admPage.getByLabel('Email').fill(S.adminEmail);
    await admPage.getByLabel('Password').fill(S.adminPassword);
    await admPage.getByRole('button', { name: 'Sign in' }).click();
    await admPage.getByText('Live', { exact: true }).waitFor({ timeout: 15_000 });
    await admPage.goto(`${APP}/orders`);
    await admPage.getByText('#' + orderA.number).waitFor();
    check((await admPage.locator('tr', { hasText: '#' + orderA.number }).textContent()).includes('paid'), 'staff see the web order as paid on the Orders page');
    check((await admPage.locator('tr', { hasText: '#' + orderB.number }).textContent()).includes('Online'), 'staff see the WhatsApp order as an Online payment');
    await admPage.screenshot({ path: path.join(OUT, 'orders-paid.png') });

    const real = consoleErrors.filter((e) => !/favicon|Failed to load resource.*404/i.test(e));
    check(real.length === 0, `no browser console errors${real.length ? `: ${real.join(' | ')}` : ''}`);
    const links = razorpay.links();
    check(links.length === 2 && links.every((l) => l.status === 'paid' && l.webhookStatus === 200), 'both Razorpay links were paid and their webhooks were accepted (200)');
  } catch (err) {
    await Promise.all((browser?.contexts() ?? []).flatMap((c) => c.pages()).map((p, i) => p.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => undefined)));
    console.error(`\n✘ ${err.message}\n\n--- last server log ---\n${serverLog.slice(-2500)}`);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill('SIGTERM');
    await Promise.all([razorpay.close(), meta.close()]);
    await sleep(300);
  }
  if (!process.exitCode) console.log(`\nE2E PASSED — ${steps.length} checks`);
}

main().catch((err) => { console.error(err); process.exit(1); });
