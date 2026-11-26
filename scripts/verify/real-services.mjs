#!/usr/bin/env node
// Real-service verification (T67). Needs TEST credentials; creates nothing that costs money.
//   node scripts/verify/real-services.mjs razorpay            # creates + reads + cancels a ₹1 test payment link
//   node scripts/verify/real-services.mjs razorpay-webhook 8787   # listens for REAL signed webhooks (expose with a tunnel)
//   node scripts/verify/real-services.mjs whatsapp            # sends an interactive message and a template to VERIFY_WHATSAPP_TO
// Secrets come from the environment only and are never printed. Output is a PASS/FAIL list to paste into docs/7_SECURITY_AUDIT.md.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const env = (k, required = true) => {
  const v = process.env[k];
  if (!v && required) { console.error(`Missing ${k}. See docs/DEPLOYMENT_GUIDE.md §5.8.`); process.exit(2); }
  return v;
};
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const shape = (o) => Object.keys(o ?? {}).sort().join(',');

async function razorpay() {
  const keyId = env('RAZORPAY_KEY_ID');
  if (!keyId.startsWith('rzp_test_')) { console.error('Refusing to run with a non-test Razorpay key (must start with rzp_test_).'); process.exit(2); }
  const auth = `Basic ${Buffer.from(`${keyId}:${env('RAZORPAY_KEY_SECRET')}`).toString('base64')}`;
  const base = (process.env.RAZORPAY_API_BASE ?? 'https://api.razorpay.com').replace(/\/$/, '');
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  // Same body as src/api/src/payments/razorpay.ts createPaymentLink.
  const created = await call('POST', '/v1/payment_links', {
    amount: 100, currency: 'INR', accept_partial: false, reference_id: `verify-${Date.now()}`, description: 'StockSync verification (test)',
    customer: { name: 'Verify' }, notify: { sms: false, email: false }, reminder_enable: false, notes: { purpose: 'verification' },
    callback_url: 'https://example.com/shop/order/verify', callback_method: 'get', expire_by: Math.floor(Date.now() / 1000) + 1800,
  });
  record('create payment link accepted (HTTP 200)', created.status === 200, `status ${created.status}${created.status !== 200 ? ` ${JSON.stringify(created.json.error ?? {})}` : ''}`);
  if (created.status !== 200) return;
  const l = created.json;
  record('response has id, short_url, status (what linkResponse parses)', Boolean(l.id && l.short_url && l.status), `fields: ${shape(l)}`);
  record('status is "created"', l.status === 'created', String(l.status));
  console.log(`      pay it with the TEST UPI id success@razorpay: ${l.short_url}`);
  const fetched = await call('GET', `/v1/payment_links/${l.id}`);
  record('fetch the link back', fetched.status === 200 && fetched.json.id === l.id);
  const cancelled = await call('POST', `/v1/payment_links/${l.id}/cancel`, {});
  record('cancel the link', cancelled.status === 200 && cancelled.json.status === 'cancelled', String(cancelled.json.status ?? cancelled.status));
}

async function razorpayWebhook(port) {
  const secret = env('RAZORPAY_WEBHOOK_SECRET');
  console.log(`Listening on :${port}. Point the Razorpay (test) webhook at https://<your-tunnel>/ and pay a link; Ctrl+C when done.`);
  createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const given = Buffer.from(String(req.headers['x-razorpay-signature'] ?? ''), 'hex');
      const want = createHmac('sha256', secret).update(raw).digest();
      const ok = given.length === want.length && timingSafeEqual(given, want);
      let event = {};
      try { event = JSON.parse(raw.toString('utf8')); } catch { /* not json */ }
      record(`real webhook signature valid (${event.event ?? 'unknown event'})`, ok, `event id header: ${req.headers['x-razorpay-event-id'] ?? 'MISSING'}`);
      console.log(`      payload keys: ${shape(event)} · payload.payment_link.entity keys: ${shape(event.payload?.payment_link?.entity)}`);
      res.writeHead(200).end('ok');
    });
  }).listen(Number(port));
}

async function whatsapp() {
  const token = env('WHATSAPP_TOKEN');
  const phoneId = env('WHATSAPP_PHONE_NUMBER_ID');
  const to = env('VERIFY_WHATSAPP_TO').replace(/[^0-9]/g, '');
  const version = process.env.META_GRAPH_VERSION ?? 'v21.0';
  const send = async (message) => {
    const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }), signal: AbortSignal.timeout(15_000) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  // The recipient must have messaged the test number in the last 24 h for the interactive message to be delivered.
  const buttons = await send({ type: 'interactive', interactive: { type: 'button', body: { text: 'StockSync verification: tap a button' },
    action: { buttons: [{ type: 'reply', reply: { id: 'verify:a', title: 'Option A' } }, { type: 'reply', reply: { id: 'verify:b', title: 'Option B' } }] } } });
  record('interactive buttons accepted', buttons.status === 200 && Boolean(buttons.json.messages?.[0]?.id), buttons.status === 200 ? `wamid ${buttons.json.messages?.[0]?.id}` : JSON.stringify(buttons.json.error ?? {}));
  const list = await send({ type: 'interactive', interactive: { type: 'list', body: { text: 'StockSync verification: pick one' },
    action: { button: 'Choose', sections: [{ title: 'Items', rows: [{ id: 'verify:1', title: 'Item 1', description: 'First' }, { id: 'verify:2', title: 'Item 2' }] }] } } });
  record('interactive list accepted', list.status === 200 && Boolean(list.json.messages?.[0]?.id), list.status === 200 ? '' : JSON.stringify(list.json.error ?? {}));
  const cta = await send({ type: 'interactive', interactive: { type: 'cta_url', body: { text: 'StockSync verification: pay link' },
    action: { name: 'cta_url', parameters: { display_text: 'Pay now', url: 'https://example.com/pay' } } } });
  record('interactive cta_url (pay button) accepted', cta.status === 200 && Boolean(cta.json.messages?.[0]?.id), cta.status === 200 ? '' : JSON.stringify(cta.json.error ?? {}));
  const tpl = await send({ type: 'template', template: { name: process.env.VERIFY_TEMPLATE_NAME ?? 'hello_world', language: { code: process.env.VERIFY_TEMPLATE_LANG ?? 'en_US' } } });
  record('template message accepted (works outside the 24h window)', tpl.status === 200 && Boolean(tpl.json.messages?.[0]?.id), tpl.status === 200 ? '' : JSON.stringify(tpl.json.error ?? {}));
  console.log('      Then check on the phone: tap a button and confirm the app received action id "verify:a" (Inbox), and that status ticks arrive (sent → delivered → read).');
}

const [, , cmd, arg] = process.argv;
const commands = { razorpay, 'razorpay-webhook': () => razorpayWebhook(arg ?? '8787'), whatsapp };
if (!commands[cmd]) { console.error('Usage: real-services.mjs <razorpay | razorpay-webhook [port] | whatsapp>'); process.exit(2); }
await commands[cmd]();
if (cmd !== 'razorpay-webhook') {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
