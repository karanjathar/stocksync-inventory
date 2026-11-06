// Local stand-ins for third-party APIs, used by the E2E run (scripts/e2e/payments.e2e.mjs).
// They implement only what StockSync calls, following the providers' documented formats (docs/3_SCHEMAS.md §3.9–3.11),
// so the whole payment and chat flows can be exercised without real accounts. They are NOT the real services:
// a test-mode run against real Razorpay / Meta remains a release-checklist item.
import http from 'node:http';
import { createHmac } from 'node:crypto';

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const listen = (server) => new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;

/**
 * Fake Razorpay: Payment Links API + a hosted pay page. When a link is "paid" it delivers a SIGNED `payment_link.paid`
 * webhook to the app (asynchronously, after `webhookDelayMs`, like the real thing) and redirects the shopper back
 * to the link's callback_url with the documented query parameters.
 */
export async function startFakeRazorpay({ keyId, keySecret, webhookSecret, webhookUrl, webhookDelayMs = 600 }) {
  const links = new Map();
  let linkCount = 0;
  let eventCount = 0;
  let base = '';

  async function deliverPaidWebhook(link) {
    const payload = {
      entity: 'event',
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: link.id, status: 'paid', amount: link.amount, amount_paid: link.amount, reference_id: link.referenceId } },
        payment: { entity: { id: link.paymentId, amount: link.amount, status: 'captured', method: 'upi' } },
      },
    };
    const raw = JSON.stringify(payload);
    eventCount += 1;
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', webhookSecret).update(raw).digest('hex'),
        'x-razorpay-event-id': `evt_e2e_${eventCount}`,
      },
      body: raw,
    });
    link.webhookStatus = res.status;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    try {
      if (req.method === 'POST' && url.pathname === '/v1/payment_links') {
        const expected = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
        if (req.headers.authorization !== expected) return json(res, 401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
        const b = JSON.parse(await readBody(req));
        if (!Number.isInteger(b.amount) || b.amount <= 0) return json(res, 400, { error: { description: 'amount must be a positive integer (paise)' } });
        if (b.currency !== 'INR') return json(res, 400, { error: { description: 'currency must be INR' } });
        if (!b.expire_by || b.expire_by < Date.now() / 1000 + 15 * 60) return json(res, 400, { error: { description: 'expire_by should be at least 15 minutes after current time' } });
        linkCount += 1;
        const id = `plink_E2E${linkCount}`;
        links.set(id, { id, amount: b.amount, referenceId: b.reference_id, callbackUrl: b.callback_url, description: b.description, status: 'created', paymentId: `pay_E2E${linkCount}`, webhookStatus: null });
        return json(res, 200, { id, short_url: `${base}/pay/${id}`, status: 'created', amount: b.amount, reference_id: b.reference_id });
      }
      let m = /^\/v1\/payment_links\/([\w]+)\/cancel$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const link = links.get(m[1]);
        if (!link) return json(res, 404, { error: { description: 'The id provided does not exist' } });
        link.status = 'cancelled';
        return json(res, 200, { id: link.id, status: 'cancelled' });
      }
      m = /^\/pay\/([\w]+)$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        const link = links.get(m[1]);
        res.writeHead(link ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
        if (!link) return res.end('<h1>Not found</h1>');
        return res.end(`<!doctype html><meta charset="utf-8"><title>Fake Razorpay</title>
          <body style="font-family:system-ui;max-width:420px;margin:40px auto">
            <h1>Fake Razorpay</h1><p>${link.description}</p><p style="font-size:2rem"><strong>${rupees(link.amount)}</strong></p>
            ${link.status === 'created'
    ? `<form method="post" action="/pay/${link.id}"><button type="submit" style="font-size:1.2rem;padding:10px 20px">Pay now</button></form>`
    : `<p>This link is ${link.status} and cannot be paid.</p>`}
          </body>`);
      }
      if (m && req.method === 'POST') {
        const link = links.get(m[1]);
        if (!link || link.status !== 'created') { res.writeHead(409); return res.end('not payable'); }
        link.status = 'paid';
        setTimeout(() => { deliverPaidWebhook(link).catch((err) => { link.webhookStatus = `error: ${err.message}`; }); }, webhookDelayMs);
        const q = new URLSearchParams({
          razorpay_payment_id: link.paymentId,
          razorpay_payment_link_id: link.id,
          razorpay_payment_link_reference_id: link.referenceId,
          razorpay_payment_link_status: 'paid',
          razorpay_signature: createHmac('sha256', keySecret).update(`${link.id}|${link.referenceId}|paid|${link.paymentId}`).digest('hex'),
        });
        res.writeHead(303, { location: `${link.callbackUrl}${link.callbackUrl.includes('?') ? '&' : '?'}${q}` });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/_links') return json(res, 200, [...links.values()]);
      res.writeHead(404);
      res.end();
    } catch (err) {
      json(res, 500, { error: { description: String(err) } });
    }
  });
  const port = await listen(server);
  base = `http://127.0.0.1:${port}`;
  return { url: base, links: () => [...links.values()], close: () => close(server) };
}

/** Fake Meta Graph API: records every message the app sends (WhatsApp `/{phone-id}/messages`, Messenger `/me/messages`). */
export async function startFakeMeta() {
  const messages = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.method === 'POST' && /^\/v[\d.]+\/[\w]+\/messages$/.test(url.pathname)) {
      const body = JSON.parse(await readBody(req));
      messages.push({ path: url.pathname, auth: req.headers.authorization, body, at: Date.now() });
      return json(res, 200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.FAKE${messages.length}` }] });
    }
    if (req.method === 'GET' && url.pathname === '/_messages') return json(res, 200, messages);
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, messages, close: () => close(server) };
}
