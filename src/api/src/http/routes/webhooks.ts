import { Router, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Container } from '../../container.js';
import { parseMetaWebhook, parseWhatsAppStatuses, parseTelegramUpdate, telegramCallbackId } from '../../channels/parse.js';
import { verifyWebhookSignature } from '../../payments/razorpay.js';
import { parseSubscriptionEvent } from '../../payments/razorpaySubscriptions.js';
import { runWithTenant } from '../../db/tenant.js';
import { NotFoundError } from '../../domain/errors.js';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Webhooks. Each business has its own URL (`/webhooks/<channel>/<businessId>`) and is verified with its OWN secret, so a payload signed for one
 * business can never be accepted for another. The original URLs without an id serve the default business (single-business installs).
 */
export function webhookRoutes(c: Container): Router {
  // A refused webhook is logged (kind of webhook only: never the body or signature) so an alert can notice a wave of them (a leaked URL, a wrong secret).
  const reject = (req: { path: string }, res: Response): void => {
    c.logger.warn({ webhook: req.path.split('/')[1] ?? 'unknown', reason: 'bad_signature' }, 'webhook rejected');
    res.status(401).json(badSignature);
  };
  const r = Router();
  r.use(rateLimit({ windowMs: 60_000, limit: c.env.NODE_ENV === 'test' ? 10_000 : 1200, standardHeaders: true, legacyHeaders: false }));

  const tenantScope: RequestHandler = async (req, _res, next) => {
    const raw = req.params.tenantId;
    if (raw === undefined) { next(); return; }
    const id = String(raw);
    if (!UUID_RE.test(id) || !(await c.tenantDirectory.isActive(id))) throw new NotFoundError('Webhook'); // unknown, malformed or suspended
    await runWithTenant(id, async () => { next(); });
  };

  // Meta (WhatsApp / Messenger / Instagram) subscription handshake.
  r.get(['/meta', '/meta/:tenantId'], tenantScope, async (req, res) => {
    const token = (await c.channelCredentials.get('meta'))?.verifyToken;
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

  r.post(['/meta', '/meta/:tenantId'], tenantScope, async (req, res) => {
    const secret = (await c.channelCredentials.get('meta'))?.appSecret;
    if (!secret) { res.status(503).json(notConfigured); return; }
    if (!verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), secret)) { reject(req, res); return; }
    for (const s of parseWhatsAppStatuses(req.body)) {
      const updated = await c.messages.applyDeliveryStatus('whatsapp', s.id, s.status, { ...(s.errorCode ? { code: s.errorCode } : {}), ...(s.errorTitle ? { title: s.errorTitle } : {}) });
      if (updated) c.events.publish({ type: 'message.status', messageId: updated.id, channel: 'whatsapp', to: updated.to, status: s.status, ...(s.errorCode ? { errorCode: s.errorCode } : {}) });
    }
    for (const msg of parseMetaWebhook(req.body)) await c.inbox.receive(msg);
    res.status(200).send('EVENT_RECEIVED');
  });

  r.post(['/telegram', '/telegram/:tenantId'], tenantScope, async (req, res) => {
    const secret = (await c.channelCredentials.get('telegram'))?.webhookSecret;
    if (!secret) { res.status(503).json(notConfigured); return; }
    const given = req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(given, secret)) { reject(req, res); return; }
    const tapId = telegramCallbackId(req.body);
    if (tapId) await c.hub.acknowledgeTap('telegram', tapId).catch((err: unknown) => c.logger.warn({ err: String(err) }, 'answerCallbackQuery failed'));
    const msg = parseTelegramUpdate(req.body);
    if (msg) await c.inbox.receive(msg);
    res.status(200).json({ ok: true });
  });

  // Razorpay Payment Links: payment state changes only here (D-003). Signature over the raw body, event-id idempotent.
  r.post(['/razorpay', '/razorpay/:tenantId'], tenantScope, async (req, res) => {
    const secret = (await c.razorpayProvider.client()).webhookSecret;
    if (!secret) { res.status(503).json(notConfigured); return; }
    if (!verifyWebhookSignature(req.rawBody, req.header('x-razorpay-signature'), secret)) { reject(req, res); return; }
    await c.payments.handleWebhook(req.header('x-razorpay-event-id'), req.rawBody, req.body);
    res.status(200).json({ ok: true });
  });

  // Razorpay Subscriptions on the PLATFORM account: plan changes happen only here. Not tied to any business URL; the subscription id finds the business.
  r.post('/razorpay-billing', async (req, res) => {
    const secret = c.subscriptions.webhookSecret;
    if (!secret || !c.billingWebhooks) { res.status(503).json(notConfigured); return; }
    if (!verifyWebhookSignature(req.rawBody, req.header('x-razorpay-signature'), secret)) { reject(req, res); return; }
    const ev = parseSubscriptionEvent(req.body);
    if (ev) await c.billingWebhooks.handle(req.header('x-razorpay-event-id'), req.rawBody, ev); // other event types (payments, refunds of the platform account) are acknowledged and ignored
    res.status(200).json({ ok: true });
  });

  return r;
}
