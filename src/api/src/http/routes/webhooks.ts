import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Container } from '../../container.js';
import { parseMetaWebhook, parseTelegramUpdate, telegramCallbackId } from '../../channels/parse.js';
import { verifyWebhookSignature } from '../../payments/razorpay.js';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(header, expected);
}

const notConfigured = { error: { code: 'NOT_CONFIGURED', message: 'Webhook secret is not configured' } };
const badSignature = { error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } };

export function webhookRoutes(c: Container): Router {
  const r = Router();
  r.use(rateLimit({ windowMs: 60_000, limit: c.env.NODE_ENV === 'test' ? 10_000 : 1200, standardHeaders: true, legacyHeaders: false }));

  // Meta (WhatsApp / Messenger / Instagram) subscription handshake.
  r.get('/meta', (req, res) => {
    const token = c.env.META_VERIFY_TOKEN;
    if (!token) { res.status(503).json(notConfigured); return; }
    const mode = req.query['hub.mode'];
    const given = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && typeof given === 'string' && safeEqual(given, token) && typeof challenge === 'string') {
      res.type('text/plain').send(challenge.slice(0, 200));
      return;
    }
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Verification failed' } });
  });

  r.post('/meta', async (req, res) => {
    const secret = c.env.META_APP_SECRET;
    if (!secret) { res.status(503).json(notConfigured); return; }
    if (!verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), secret)) { res.status(401).json(badSignature); return; }
    for (const msg of parseMetaWebhook(req.body)) await c.inbox.receive(msg);
    res.status(200).send('EVENT_RECEIVED');
  });

  r.post('/telegram', async (req, res) => {
    const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) { res.status(503).json(notConfigured); return; }
    const given = req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(given, secret)) { res.status(401).json(badSignature); return; }
    const tapId = telegramCallbackId(req.body);
    if (tapId) await c.hub.acknowledgeTap('telegram', tapId).catch((err: unknown) => c.logger.warn({ err: String(err) }, 'answerCallbackQuery failed'));
    const msg = parseTelegramUpdate(req.body);
    if (msg) await c.inbox.receive(msg);
    res.status(200).json({ ok: true });
  });

  // Razorpay Payment Links: payment state changes only here (D-003). Signature over the raw body, event-id idempotent.
  r.post('/razorpay', async (req, res) => {
    const secret = c.razorpay.webhookSecret;
    if (!secret) { res.status(503).json(notConfigured); return; }
    if (!verifyWebhookSignature(req.rawBody, req.header('x-razorpay-signature'), secret)) { res.status(401).json(badSignature); return; }
    await c.payments.handleWebhook(req.header('x-razorpay-event-id'), req.rawBody, req.body);
    res.status(200).json({ ok: true });
  });

  return r;
}
