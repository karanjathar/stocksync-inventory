import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Captured } from './fakeFetch.js';

/** Fake Razorpay: answers Payment Links calls with incrementing ids; records requests; can simulate an outage. */
export function fakeRazorpay() {
  const calls: Captured[] = [];
  let n = 0;
  let failing = false;
  let delayMs = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failing) return Response.json({ error: { description: 'The server is down for maintenance' } }, { status: 503 });
    if (url.endsWith('/v1/payment_links')) {
      n += 1;
      return Response.json({ id: `plink_${n}`, short_url: `https://rzp.io/i/link${n}`, status: 'created' });
    }
    if (url.includes('/cancel')) return Response.json({ status: 'cancelled' });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { fn, calls, links: () => calls.filter((c) => c.url.endsWith('/v1/payment_links')), setFailing: (v: boolean) => { failing = v; }, setDelay: (ms: number) => { delayMs = ms; } };
}

/** Sends a correctly signed Razorpay webhook to the app. */
export function signedRazorpayWebhook(app: Express, body: unknown, opts: { eventId: string; secret?: string }) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', opts.secret ?? 'whsec').update(raw).digest('hex');
  return request(app).post('/webhooks/razorpay').set('content-type', 'application/json')
    .set('x-razorpay-signature', sig).set('x-razorpay-event-id', opts.eventId).send(raw);
}

export function paidLinkEvent(plink: string, amount: number) {
  return {
    entity: 'event', event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: plink, status: 'paid', amount, amount_paid: amount } },
      payment: { entity: { id: `pay_${plink}`, amount, status: 'captured', method: 'upi' } },
    },
  };
}
