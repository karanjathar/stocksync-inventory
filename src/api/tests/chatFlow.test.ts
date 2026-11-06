import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../src/domain/errors.js';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import type { InboundMessage } from '../src/domain/types.js';
import type { BotReply } from '../src/channels/reply.js';

let t: TestApp;
const id: Record<string, string> = {};
const tap = (action: string, from = '919800000001'): Promise<BotReply> =>
  t.c.bot.handle({ channel: 'whatsapp', from, text: action, action, senderName: 'Meera' } satisfies InboundMessage);
const rows = (r: BotReply) => r.list?.sections.flatMap((s) => s.rows) ?? [];

beforeAll(async () => {
  t = await buildTestApp();
  const h = { authorization: `Bearer ${await t.token('staff')}` };
  const post = async (path: string, body: object) => (await request(t.app).post(path).set(h).send(body)).body as { id: string };
  id.wh = (await post('/api/warehouses', { code: 'MAIN', name: 'Main' })).id;
  id.apparel = (await post('/api/categories', { name: 'Apparel' })).id;
  id.home = (await post('/api/categories', { name: 'Home' })).id;
  await post('/api/categories', { name: 'Empty' });
  id.tee = (await post('/api/products', { sku: 'TEE', name: 'Red T-Shirt', priceCents: 49900, categoryId: id.apparel, description: 'Soft cotton', attributes: { size: 'M' } })).id;
  id.cap = (await post('/api/products', { sku: 'CAP', name: 'Cap', priceCents: 39900, categoryId: id.apparel })).id; // no stock
  id.mug = (await post('/api/products', { sku: 'MUG', name: 'Mug', priceCents: 29900, categoryId: id.home })).id;
  for (let i = 1; i <= 11; i++) {
    const p = await post('/api/products', { sku: `SOCK-${i}`, name: `Sock ${String(i).padStart(2, '0')}`, priceCents: 9900, categoryId: id.apparel });
    await t.c.stock.receive({ productId: p.id, warehouseId: id.wh, quantity: 2 }, null);
  }
  await t.c.stock.receive({ productId: id.tee, warehouseId: id.wh, quantity: 3 }, null);
  await t.c.stock.receive({ productId: id.mug, warehouseId: id.wh, quantity: 20 }, null);
  await t.c.settings.update({ businessName: 'Corner Shop', currency: 'INR' });
});
afterAll(async () => { await t.close(); });

describe('menu & browsing (T31)', () => {
  it('menu shows Browse / My cart / My orders buttons', async () => {
    const r = await tap('menu');
    expect(r.text).toContain('Corner Shop');
    expect(r.buttons?.map((b) => b.id)).toEqual(['catalog', 'cart', 'orders']);
  });

  it('catalog lists only categories with orderable products, plus All products', async () => {
    const r = await tap('catalog');
    expect(rows(r).map((x) => [x.id, x.title, x.description])).toEqual([
      [`cat:${id.apparel}:0`, 'Apparel', '12 products'],
      [`cat:${id.home}:0`, 'Home', '1 product'],
      ['cat:all:0', 'All products', '13 products'],
    ]);
  });

  it('category lists products 9 per page with a More… row', async () => {
    const page1 = rows(await tap(`cat:${id.apparel}:0`));
    expect(page1).toHaveLength(10);
    expect(page1[0]).toEqual({ id: `prod:${id.tee}`, title: 'Red T-Shirt', description: '₹499.00 · 3 left' });
    expect(page1.at(-1)).toEqual({ id: `cat:${id.apparel}:9`, title: 'More…', description: 'Show 3 more' });
    const page2 = rows(await tap(`cat:${id.apparel}:9`));
    expect(page2.map((x) => x.title)).toEqual(['Sock 09', 'Sock 10', 'Sock 11']);
    expect(page1.some((x) => x.title === 'Cap')).toBe(false); // out of stock
  });

  it('product detail shows price, stock, description and a quantity list capped at stock', async () => {
    const r = await tap(`prod:${id.tee}`);
    expect(r.text).toContain('Red T-Shirt');
    expect(r.text).toContain('₹499.00');
    expect(r.text).toContain('3 in stock');
    expect(r.text).toContain('Soft cotton');
    expect(r.text).toContain('size: M');
    expect(rows(r).map((x) => x.id)).toEqual([`qty:${id.tee}:1`, `qty:${id.tee}:2`, `qty:${id.tee}:3`]);
    expect(rows(await tap(`prod:${id.mug}`)).map((x) => x.title)).toEqual(['1', '2', '3', '4', '5', '10']);
  });

  it('adding to cart confirms with totals and next-step buttons', async () => {
    const r = await tap(`qty:${id.tee}:2`);
    expect(r.text).toContain('Added 2 × Red T-Shirt');
    expect(r.text).toContain('₹998.00');
    expect(r.buttons?.map((b) => b.id)).toEqual(['checkout', 'catalog', 'cart:clear']);
    const again = await tap(`qty:${id.tee}:5`);
    expect(again.text).toContain('only 3 available');
  });

  it('out-of-stock, unknown and malformed taps degrade gracefully', async () => {
    expect((await tap(`prod:${id.cap}`)).text).toMatch(/not available/i);
    expect((await tap(`qty:${id.cap}:1`)).text).toMatch(/not available/i);
    expect((await tap('prod:00000000-0000-0000-0000-000000000000')).buttons?.[0]!.id).toBe('catalog');
    expect((await tap('qty:not-a-uuid:2')).buttons?.map((b) => b.id)).toContain('catalog');
    expect((await tap(`cat:${id.apparel}:-5`)).list).toBeDefined();
  });

  it('typed v1 commands are unaffected', async () => {
    expect((await t.c.bot.handle({ channel: 'whatsapp', from: '919800000001', text: 'stock tee' })).text).toContain('Red T-Shirt (TEE): 3 pcs available') // carts don't reserve stock;
  });
});

describe('cart & checkout (T32)', () => {
  const buyer = '919800000002';
  const tapAs = (a: string) => tap(a, buyer);

  it('empty cart and empty checkout say so with a Browse button', async () => {
    for (const a of ['cart', 'checkout', 'pay:cod']) {
      const r = await tapAs(a);
      expect(r.text).toMatch(/cart is empty/i);
      expect(r.buttons?.[0]!.id).toBe('catalog');
    }
  });

  it('cart shows lines and total with next-step buttons', async () => {
    await tapAs(`qty:${id.tee}:2`);
    await tapAs(`qty:${id.mug}:1`);
    const r = await tapAs('cart');
    expect(r.text).toContain('2 × Red T-Shirt — ₹998.00');
    expect(r.text).toContain('1 × Mug — ₹299.00');
    expect(r.text).toContain('Total: ₹1,297.00');
    expect(r.buttons?.map((b) => b.id)).toEqual(['checkout', 'catalog', 'cart:clear']);
  });

  it('checkout offers cash on delivery only while online payments are unavailable', async () => {
    const r = await tapAs('checkout');
    expect(r.text).toContain('Total: ₹1,297.00');
    expect(r.buttons?.map((b) => b.id)).toEqual(['pay:cod', 'cart']); // 'cart' = Edit cart
    expect(r.buttons?.[0]!.title).toBe('💵 Cash on delivery');
    expect((await tapAs('pay:online')).text).toMatch(/online payment is not available/i);
  });

  it('pay:cod places a COD order from the cart and clears it', async () => {
    const r = await tapAs('pay:cod');
    expect(r.text).toMatch(/Order #\d+ placed/);
    expect(r.text).toContain('Cash on delivery');
    expect(r.text).toContain('₹1,297.00');
    expect(r.buttons?.map((b) => b.id)).toEqual(['orders', 'catalog']);
    const [order] = await t.c.orders.list({ status: 'PENDING' });
    expect(order).toMatchObject({ channel: 'whatsapp', paymentMethod: 'COD', totalCents: 129700, customerName: 'Meera' });
    expect(order!.items.map((i) => [i.sku, i.quantity])).toEqual([['MUG', 1], ['TEE', 2]]);
    expect((await tapAs('cart')).text).toMatch(/cart is empty/i);
  });

  it('online checkout uses the injected payment options and creates an ONLINE order', async () => {
    t.c.chatFlow.setPaymentOptions({
      available: async () => ({ online: true, cod: false }),
      onlineCheckout: async (order) => ({ text: `PAY-LINK for #${order.number}` }),
      resendLink: async (order) => ({ text: `RESEND for #${order.number}` }),
    });
    try {
      await tapAs(`qty:${id.mug}:2`);
      expect((await tapAs('checkout')).buttons?.map((b) => b.id)).toEqual(['pay:online', 'cart']);
      expect((await tapAs('pay:cod')).text).toMatch(/cash on delivery is not available/i);
      const r = await tapAs('pay:online');
      expect(r.text).toMatch(/^PAY-LINK for #\d+$/);
      const [order] = await t.c.orders.list({ status: 'PENDING' });
      expect(order).toMatchObject({ paymentMethod: 'ONLINE', totalCents: 59800 });
    } finally {
      t.c.chatFlow.setPaymentOptions(t.c.payments.chatOptions());
    }
  });

  it('clear empties the cart; checkout reports items that changed since they were added', async () => {
    await tapAs(`qty:${id.tee}:1`);
    expect((await tapAs('cart:clear')).text).toMatch(/cart cleared/i);
    expect((await tapAs('cart')).text).toMatch(/cart is empty/i);
    await tapAs(`qty:${id.mug}:3`);
    await request(t.app).patch(`/api/products/${id.mug}`).set({ authorization: `Bearer ${await t.token('staff')}` }).send({ isActive: false });
    const r = await tapAs('checkout');
    expect(r.text).toMatch(/some items changed/i);
    expect(r.text).toMatch(/cart is empty/i);
    await request(t.app).patch(`/api/products/${id.mug}`).set({ authorization: `Bearer ${await t.token('staff')}` }).send({ isActive: true });
  });
});

describe('my orders (T33)', () => {
  const me = '919800000003';
  const stranger = '919800000099';

  it('no orders yet → friendly message', async () => {
    const r = await tap('orders', me);
    expect(r.text).toMatch(/no orders yet/i);
    expect(r.buttons?.[0]!.id).toBe('catalog');
  });

  it('lists only my last 5 orders, newest first', async () => {
    for (let i = 0; i < 6; i++) { await tap(`qty:${id.mug}:1`, me); await tap('pay:cod', me); }
    await tap(`qty:${id.mug}:1`, stranger); await tap('pay:cod', stranger);
    const r = await tap('orders', me);
    const list = rows(r);
    expect(list).toHaveLength(5);
    const mine = (await t.c.orders.list({})).filter((o) => o.customerName === 'Meera' && o.channel === 'whatsapp');
    const myNumbers = new Set(mine.map((o) => o.number));
    const shown = list.map((x) => Number(/^order:(\d+)$/.exec(x.id)![1]));
    expect(shown.every((n) => myNumbers.has(n))).toBe(true);
    expect(shown).toEqual([...shown].sort((a, b) => b - a));
    expect(list[0]!.title).toMatch(/^#\d+ · Pending$/);
    expect(list[0]!.description).toBe('₹299.00 · 1 item · Cash on delivery');
  });

  it('order detail shows status, payment and items — but never someone else’s order', async () => {
    const mineList = rows(await tap('orders', me));
    const n = mineList[0]!.id.split(':')[1];
    const r = await tap(`order:${n}`, me);
    expect(r.text).toContain(`Order #${n}`);
    expect(r.text).toContain('Status: Pending');
    expect(r.text).toContain('Payment: Cash on delivery · unpaid');
    expect(r.text).toContain('1 × Mug');
    expect(r.buttons?.map((b) => b.id)).toEqual(['orders', 'catalog']);
    const strangerOrder = rows(await tap('orders', stranger))[0]!.id.split(':')[1];
    expect((await tap(`order:${strangerOrder}`, me)).text).toMatch(/couldn't find that order/i);
    expect((await tap('order:999999', me)).text).toMatch(/couldn't find that order/i);
  });

  it('typed "hi" or unknown text shows the full menu (FR-R2-7)', async () => {
    const r = await t.c.bot.handle({ channel: 'whatsapp', from: me, text: 'hi' });
    expect(r.buttons?.map((b) => b.id)).toEqual(['catalog', 'cart', 'orders']);
    expect(r.text).toContain('stock <SKU>'); // text commands still documented
  });
});

describe('checkout is idempotent under concurrent taps (T46)', () => {
  const who = '919800000046';
  const taps = (action: string, n: number) => Array.from({ length: n }, (_, i) =>
    t.c.inbox.receive({ channel: 'whatsapp', from: who, text: action, action, externalId: `wamid.T46.${action}.${i}.${Math.random()}` }));
  const myOrders = async () => (await t.c.orders.list({})).filter((o) => o.items.length && o.customerId === customerId);
  let customerId = '';

  it('five simultaneous pay:cod taps create exactly one order', async () => {
    customerId = (await t.c.customers.findOrCreateByChannel('whatsapp', who, 'Racer')).id;
    await tap(`qty:${id.mug}:2`, who);
    await Promise.all(taps('pay:cod', 5));
    const orders = await myOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.items[0]!.quantity).toBe(2);
    expect((await t.c.carts.get(customerId)).lines).toEqual([]);
  });

  it('restores the cart if the order cannot be created', async () => {
    await tap(`qty:${id.mug}:1`, who);
    const spy = vi.spyOn(t.c.orders, 'create').mockRejectedValueOnce(new ConflictError('Product not available: MUG'));
    try {
      const r = await tap('pay:cod', who);
      expect(r.text).toMatch(/Sorry — Product not available/);
    } finally {
      spy.mockRestore();
    }
    expect((await t.c.carts.get(customerId)).lines.map((l) => [l.sku, l.quantity])).toEqual([['MUG', 1]]);
    expect(await myOrders()).toHaveLength(1);
  });
});
