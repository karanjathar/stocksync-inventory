import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { ConflictError, InsufficientStockError, NotFoundError } from '../../domain/errors.js';
import type { PaymentMethod } from '../../domain/types.js';
import { ALLOWED_IMAGE_TYPES } from '../../storage/blob.js';
import { requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

const orderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'invalid phone'),
  notes: z.string().trim().max(1000).optional(),
  paymentMethod: z.enum(['COD', 'ONLINE']).optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(1000) })).min(1).max(50),
});

/** Anonymous storefront API used by the public website. */
export function publicRoutes(c: Container): Router {
  const r = Router();
  const orderLimiter = rateLimit({ windowMs: 15 * 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: true, legacyHeaders: false });

  const payLinkLimiter = rateLimit({ windowMs: 15 * 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: true, legacyHeaders: false });

  r.get('/catalog', async (_req, res) => {
    const s = await c.settings.get();
    const products = await c.repos.products.list({ activeOnly: true, limit: 1000 });
    const pay = await c.payments.config();
    const paymentMethods: PaymentMethod[] = [...(pay.onlineAvailable ? ['ONLINE' as const] : []), ...(pay.codEnabled ? ['COD' as const] : [])];
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      settings: { businessName: s.businessName, currency: s.currency, whatsappNumber: s.whatsappNumber, paymentMethods },
      products: products.map((p) => ({
        id: p.id, sku: p.sku, name: p.name, description: p.description, priceCents: p.priceCents, unit: p.unit,
        imageUrl: p.imageUrl, attributes: p.attributes, categoryId: p.categoryId,
        inStock: p.totalQuantity > 0, available: p.totalQuantity,
      })),
    });
  });

  // Prices a cart exactly as an order would be priced (tax included), so the shop shows the real total.
  const quoteLimiter = rateLimit({ windowMs: 60_000, limit: c.env.NODE_ENV === 'test' ? 10_000 : 120, standardHeaders: true, legacyHeaders: false });
  const quoteSchema = z.object({ items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(100_000) })).min(1).max(100) });
  r.post('/quote', quoteLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await c.orders.quote(parse(quoteSchema, req.body).items));
  });

  r.post('/orders', orderLimiter, async (req, res) => {
    const o = parse(orderSchema, req.body);
    // Which payment methods may be used right now (keys configured, enabled in Settings, INR for online).
    const pay = await c.payments.config();
    const enabled: PaymentMethod[] = [...(pay.codEnabled ? ['COD' as const] : []), ...(pay.onlineAvailable ? ['ONLINE' as const] : [])];
    if (!enabled.length) throw new ConflictError('Ordering is temporarily unavailable');
    const method: PaymentMethod = o.paymentMethod ?? enabled[0]!;
    if (!enabled.includes(method)) throw new ConflictError(`${method === 'ONLINE' ? 'Online payment' : 'Cash on delivery'} is not available right now`);
    for (const item of o.items) {
      const p = await c.repos.products.get(item.productId);
      if (!p || !p.isActive) throw new NotFoundError('Product');
      if (p.totalQuantity < item.quantity) throw new InsufficientStockError({ sku: p.sku, available: p.totalQuantity, requested: item.quantity });
    }
    const digits = o.phone.replace(/[^0-9]/g, '');
    const customer = await c.customers.findOrCreateByChannel('web', digits, o.name);
    const order = await c.orders.create({ customerId: customer.id, channel: 'web', items: o.items, notes: o.notes, paymentMethod: method });
    let paymentUrl: string | undefined;
    if (method === 'ONLINE') {
      try {
        paymentUrl = (await c.payments.linkForOrder(order.id)).shortUrl; // amount comes from the order, never the request
      } catch (err) {
        // No orphan pending orders when the payment provider is down: the shopper simply tries again.
        await c.orders.cancel(order.id, null).catch((e: unknown) => c.logger.warn({ err: String(e) }, 'could not cancel web order after link failure'));
        throw err;
      }
    }
    res.status(201).json({
      number: order.number, status: order.status, totalCents: order.totalCents, paymentMethod: method,
      token: order.publicToken, ...(paymentUrl ? { paymentUrl } : {}),
    });
  });

  /**
   * Resume payment: an open link, or a fresh one when the first expired / was abandoned. Authenticated only by the
   * unguessable order token (like the status page); the amount always comes from the order.
   */
  r.post('/orders/:token/payment-link', payLinkLimiter, async (req, res) => {
    const token = z.string().uuid().safeParse(req.params.token);
    const order = token.success ? await c.orders.getByPublicToken(token.data) : undefined;
    if (!order) throw new NotFoundError('Order');
    if (order.paymentMethod !== 'ONLINE' || order.paymentStatus !== 'UNPAID' || order.status === 'CANCELLED') {
      throw new ConflictError('This order cannot be paid online');
    }
    const payment = await c.payments.linkForOrder(order.id);
    res.set('Cache-Control', 'no-store');
    res.json({ paymentUrl: payment.shortUrl });
  });

  /** Shop order-status page: found by the unguessable token, exposes only what the shopper needs. */
  r.get('/orders/:token', async (req, res) => {
    const token = z.string().uuid().safeParse(req.params.token);
    const order = token.success ? await c.orders.getByPublicToken(token.data) : undefined;
    if (!order) throw new NotFoundError('Order');
    const s = await c.settings.get();
    const awaitingPayment = order.paymentMethod === 'ONLINE' && order.paymentStatus === 'UNPAID' && order.status !== 'CANCELLED';
    const link = awaitingPayment ? await c.payments.openLink(order.id) : undefined;
    res.set('Cache-Control', 'no-store');
    res.json({
      number: order.number, status: order.status, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus,
      totalCents: order.totalCents, currency: s.currency,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      ...(link ? { paymentUrl: link.shortUrl } : {}),
    });
  });

  return r;
}

const sasSchema = z.object({ filename: z.string().trim().min(1).max(200), contentType: z.enum(ALLOWED_IMAGE_TYPES) });

export function uploadRoutes(c: Container): Router {
  const r = Router();
  r.get('/status', (_req, res) => { res.json({ configured: c.images.isConfigured() }); });
  r.post('/image-sas', requireRole('staff'), async (req, res) => {
    const { contentType } = parse(sasSchema, req.body);
    res.json(await c.images.createUploadSas(contentType));
  });
  return r;
}
