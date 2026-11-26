import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { ConflictError, InsufficientStockError, NotFoundError } from '../../domain/errors.js';
import type { PaymentMethod } from '../../domain/types.js';
import { ALLOWED_IMAGE_TYPES } from '../../storage/blob.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { runWithTenant } from '../../db/tenant.js';
import { renderInvoicePdf } from '../../services/invoicePdf.js';
import { verifyInvoiceSignature } from '../../services/signedUrl.js';

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

  const invoiceLimiter = rateLimit({ windowMs: 15 * 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 60, standardHeaders: true, legacyHeaders: false });
  const payLinkLimiter = rateLimit({ windowMs: 15 * 60_000, limit: c.env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: true, legacyHeaders: false });

  // Which business does this request belong to? Resolved BEFORE any data is read, and unknown or suspended businesses are a plain 404.
  const slugScope: RequestHandler = async (req, _res, next) => {
    const slug = req.params.slug;
    if (slug === undefined) { next(); return; } // the original single-shop URLs: the default business
    const tenant = await c.tenantDirectory.bySlug(String(slug));
    if (!tenant) throw new NotFoundError('Shop');
    await runWithTenant(tenant.id, async () => { next(); });
  };
  const tokenScope: RequestHandler = async (req, _res, next) => {
    const token = z.string().uuid().safeParse(req.params.token);
    const tenantId = token.success ? await c.tenantDirectory.ofOrderToken(token.data) : undefined;
    if (!tenantId) throw new NotFoundError('Order');
    await runWithTenant(tenantId, async () => { next(); });
  };

  r.get('/s/:slug/manifest.webmanifest', slugScope, async (req, res) => {
    const s = await c.settings.get();
    const slug = String(req.params.slug);
    res.type('application/manifest+json').set('Cache-Control', 'public, max-age=300').json({
      name: s.businessName, short_name: s.businessName.slice(0, 12), start_url: `/shop/${slug}`, scope: `/shop/${slug}`, display: 'standalone',
      background_color: '#ffffff', theme_color: '#0f766e',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
  });

  /** Plans and prices for the pricing page and sign-up (no business data). */
  r.get('/plans', async (_req, res) => { res.set('Cache-Control', 'public, max-age=60').json((await c.plans.listActive()).map(({ razorpayPlanId: _hidden, ...plan }) => plan)); });

  r.get(['/catalog', '/s/:slug/catalog'], slugScope, async (_req, res) => {
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

  r.post(['/orders', '/s/:slug/orders'], orderLimiter, slugScope, async (req, res) => {
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
  r.post('/orders/:token/payment-link', payLinkLimiter, tokenScope, async (req, res) => {
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
  r.get('/orders/:token', tokenScope, async (req, res) => {
    const token = z.string().uuid().safeParse(req.params.token);
    const order = token.success ? await c.orders.getByPublicToken(token.data) : undefined;
    if (!order) throw new NotFoundError('Order');
    const s = await c.settings.get();
    const awaitingPayment = order.paymentMethod === 'ONLINE' && order.paymentStatus === 'UNPAID' && order.status !== 'CANCELLED';
    const link = awaitingPayment ? await c.payments.openLink(order.id) : undefined;
    const invoice = order.status === 'CONFIRMED' || order.status === 'FULFILLED' ? await c.invoices.getByOrder(order.id) : undefined;
    res.set('Cache-Control', 'no-store');
    res.json({
      shop: (await c.tenants.current())?.slug,
      invoiceAvailable: invoice?.status === 'ISSUED',
      number: order.number, status: order.status, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus,
      totalCents: order.totalCents, currency: s.currency,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      ...(link ? { paymentUrl: link.shortUrl } : {}),
    });
  });

  /**
   * The shopper's own GST invoice, found by the same unguessable token. Only for a confirmed or fulfilled order; anything else (unknown token,
   * unconfirmed, cancelled, invoicing not set up) is a plain 404 so the endpoint reveals nothing.
   */
  r.get('/orders/:token/invoice.pdf', invoiceLimiter, tokenScope, async (req, res) => {
    const token = z.string().uuid().safeParse(req.params.token);
    const order = token.success ? await c.orders.getByPublicToken(token.data) : undefined;
    if (!order || (order.status !== 'CONFIRMED' && order.status !== 'FULFILLED')) throw new NotFoundError('Invoice');
    const invoice = await c.invoices.issue(order.id).catch((err: unknown) => { if (err instanceof ConflictError) throw new NotFoundError('Invoice'); throw err; });
    const pdf = await renderInvoicePdf(invoice);
    res.set({ 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="invoice-${invoice.number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf"` }).send(pdf);
  });

  /** Signed download link sent in chat (T77): bound to one invoice and expiring. Any failure is the same plain 404. */
  r.get('/invoices/:id/download.pdf', invoiceLimiter, async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const exp = typeof req.query.exp === 'string' ? req.query.exp : '';
    const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
    if (!id.success || !verifyInvoiceSignature(c.env.JWT_SECRET, id.data, exp, sig)) throw new NotFoundError('Invoice');
    const tenantId = await c.tenantDirectory.ofInvoice(id.data); // the signature is checked first; only then do we look the invoice up
    if (!tenantId) throw new NotFoundError('Invoice');
    const invoice = await runWithTenant(tenantId, () => c.invoices.get(id.data));
    if (!invoice) throw new NotFoundError('Invoice');
    const pdf = await renderInvoicePdf(invoice);
    res.set({ 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="invoice-${invoice.number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf"` }).send(pdf);
  });

  return r;
}

const sasSchema = z.object({ filename: z.string().trim().min(1).max(200), contentType: z.enum(ALLOWED_IMAGE_TYPES) });

export function uploadRoutes(c: Container): Router {
  const r = Router();
  r.get('/status', (_req, res) => { res.json({ configured: c.images.isConfigured() }); });
  r.post('/image-sas', requireRole('staff'), async (req, res) => {
    const { contentType } = parse(sasSchema, req.body);
    res.json(await c.images.createUploadSas(contentType, currentUser(req).tenantId));
  });
  return r;
}
