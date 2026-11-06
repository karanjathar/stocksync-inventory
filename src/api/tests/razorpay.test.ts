import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { fakeFetch } from './helpers/fakeFetch.js';
import { RazorpayClient, verifyCallbackSignature, verifyWebhookSignature } from '../src/payments/razorpay.js';
import { loadEnv } from '../src/config/env.js';

const cfg = { keyId: 'rzp_test_KEY', keySecret: 'key-secret', webhookSecret: 'wh-secret', apiBase: 'https://api.razorpay.com' };
const hmac = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('hex');

describe('RazorpayClient.createPaymentLink (T34)', () => {
  it('sends the documented Payment Links request with Basic auth and parses the response', async () => {
    const f = fakeFetch(200, { id: 'plink_123', short_url: 'https://rzp.io/i/abc', status: 'created', amount: 99800, reference_id: 'ORD-42-1a2b' });
    const rz = new RazorpayClient(cfg, f.fn);
    const link = await rz.createPaymentLink({
      amountCents: 99800, currency: 'INR', referenceId: 'ORD-42-1a2b', description: 'Corner Shop order #42',
      customer: { name: 'Asha', contact: '+919811112222' }, callbackUrl: 'https://shop.test/shop/order/tok',
      expireBy: new Date('2026-11-07T12:00:00Z'), notes: { order_id: 'uuid-1' },
    });
    expect(link).toEqual({ id: 'plink_123', shortUrl: 'https://rzp.io/i/abc', status: 'created' });
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.razorpay.com/v1/payment_links', method: 'POST',
      headers: { authorization: `Basic ${Buffer.from('rzp_test_KEY:key-secret').toString('base64')}`, 'content-type': 'application/json' },
    });
    expect(f.calls[0]!.body).toEqual({
      amount: 99800, currency: 'INR', accept_partial: false, reference_id: 'ORD-42-1a2b',
      description: 'Corner Shop order #42', customer: { name: 'Asha', contact: '+919811112222' },
      notify: { sms: false, email: false }, reminder_enable: false, notes: { order_id: 'uuid-1' },
      callback_url: 'https://shop.test/shop/order/tok', callback_method: 'get', expire_by: 1794052800,
    });
  });

  it('omits an empty customer contact and uses a configurable base URL (fake Razorpay for E2E)', async () => {
    const f = fakeFetch(200, { id: 'plink_1', short_url: 'http://127.0.0.1:9999/pay/plink_1', status: 'created' });
    await new RazorpayClient({ ...cfg, apiBase: 'http://127.0.0.1:9999' }, f.fn).createPaymentLink({
      amountCents: 100, currency: 'INR', referenceId: 'r', description: 'd', customer: { name: 'X' },
      callbackUrl: 'https://x.test', expireBy: new Date(Date.now() + 3600_000), notes: {},
    });
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:9999/v1/payment_links');
    expect((f.calls[0]!.body as { customer: object }).customer).toEqual({ name: 'X' });
  });

  it('cancels a link', async () => {
    const f = fakeFetch(200, { id: 'plink_123', status: 'cancelled' });
    await new RazorpayClient(cfg, f.fn).cancelPaymentLink('plink_123');
    expect(f.calls[0]).toMatchObject({ url: 'https://api.razorpay.com/v1/payment_links/plink_123/cancel', method: 'POST' });
  });

  it('surfaces Razorpay errors without leaking credentials, and rejects malformed responses', async () => {
    const bad = fakeFetch(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'expire_by should be at least 15 minutes after current time' } });
    const err = await new RazorpayClient(cfg, bad.fn).cancelPaymentLink('plink_x').catch((e: Error) => e);
    expect(String(err)).toContain('400');
    expect(String(err)).toContain('expire_by should be at least 15 minutes');
    expect(String(err)).not.toContain('key-secret');
    expect(String(err)).not.toContain(Buffer.from('rzp_test_KEY:key-secret').toString('base64'));
    const weird = fakeFetch(200, { unexpected: true });
    await expect(new RazorpayClient(cfg, weird.fn).createPaymentLink({
      amountCents: 1, currency: 'INR', referenceId: 'r', description: 'd', customer: { name: 'X' }, callbackUrl: 'https://x', expireBy: new Date(), notes: {},
    })).rejects.toThrow(/unexpected response/i);
  });

  it('is configured only with key id, key secret and webhook secret', () => {
    expect(new RazorpayClient(cfg, fetch).isConfigured()).toBe(true);
    expect(new RazorpayClient({ ...cfg, webhookSecret: undefined }, fetch).isConfigured()).toBe(false);
  });
});

describe('signatures (T34)', () => {
  it('verifies webhook signatures over the exact raw body, timing-safe', () => {
    const raw = Buffer.from('{"event":"payment_link.paid","payload":{}}');
    const sig = hmac(raw.toString(), 'wh-secret');
    expect(verifyWebhookSignature(raw, sig, 'wh-secret')).toBe(true);
    expect(verifyWebhookSignature(raw, sig, 'other-secret')).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(`${raw.toString()} `), sig, 'wh-secret')).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, 'wh-secret')).toBe(false);
    expect(verifyWebhookSignature(raw, 'zz', 'wh-secret')).toBe(false);
    expect(verifyWebhookSignature(undefined, sig, 'wh-secret')).toBe(false);
  });

  it('verifies redirect callback signatures (link|reference|status|payment)', () => {
    const p = { paymentLinkId: 'plink_1', referenceId: 'ORD-1-x', status: 'paid', paymentId: 'pay_9' };
    const signature = hmac('plink_1|ORD-1-x|paid|pay_9', 'key-secret');
    expect(verifyCallbackSignature({ ...p, signature }, 'key-secret')).toBe(true);
    expect(verifyCallbackSignature({ ...p, status: 'cancelled', signature }, 'key-secret')).toBe(false);
    expect(verifyCallbackSignature({ ...p, signature: '' }, 'key-secret')).toBe(false);
  });
});

describe('env (T34)', () => {
  it('reads Razorpay settings with a default API base', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(32), RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' });
    expect(env).toMatchObject({ RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_API_BASE: 'https://api.razorpay.com' });
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(32), RAZORPAY_API_BASE: 'not a url' })).toThrow(/RAZORPAY_API_BASE/);
  });
});
