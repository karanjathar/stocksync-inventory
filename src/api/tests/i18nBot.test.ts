import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { seedCatalog } from './helpers/fixtures.js';
import { count, detectLanguage, en, hi, languageCommand, LANGS, runWithLang, t, translate, type MessageKey } from '../src/i18n/messages.js';
import type { BotReply } from '../src/channels/reply.js';
import type { InboundMessage } from '../src/domain/types.js';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('message catalogs', () => {
  it('Hindi has exactly the keys English has, none empty, with the same placeholders', () => {
    const keys = Object.keys(en) as MessageKey[];
    expect(Object.keys(hi).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      expect(hi[k].trim(), k).not.toBe('');
      expect(placeholders(hi[k]), `placeholders of ${k}`).toEqual(placeholders(en[k]));
    }
  });
  it('real Hindi: every Hindi message that is not a bare command contains Devanagari', () => {
    for (const k of Object.keys(en) as MessageKey[]) {
      if (k.startsWith('bot.help.') || k === 'btn.switchLang' || k === 'row.switchLang') continue;
      expect(/[ऀ-ॿ]/.test(hi[k]), k).toBe(true);
    }
  });
  it('fills placeholders, leaves unknown ones visible, and follows the language of the running request', () => {
    expect(translate('en', 'cart.added', { n: 2, name: 'Mug' })).toBe('✅ Added 2 × Mug to your cart.');
    expect(translate('hi', 'cart.added', { n: 2, name: 'मग' })).toBe('✅ 2 × मग आपके कार्ट में जोड़ दिया गया।');
    expect(translate('en', 'cart.added', { n: 2 })).toContain('{name}');
    expect(t('btn.browse')).toBe('🛍 Browse');                                         // no language set: English
    expect(runWithLang('hi', () => t('btn.browse'))).toBe('🛍 देखें');
    expect(runWithLang('hi', () => count('item', 1))).toBe('1 वस्तु');
    expect(runWithLang('en', () => [count('item', 1), count('item', 3)])).toEqual(['1 item', '3 items']);
    expect(LANGS).toEqual(['en', 'hi']);
  });
  it('does not leak one request\'s language into a concurrent one', async () => {
    const out = await Promise.all([runWithLang('hi', async () => { await new Promise((r) => setTimeout(r, 15)); return t('btn.cart'); }), runWithLang('en', async () => t('btn.cart'))]);
    expect(out).toEqual(['🛒 मेरा कार्ट', '🛒 My cart']);
  });
});

describe('language detection', () => {
  it('Devanagari means Hindi; Latin script, numbers and emoji mean English; mixed text goes by the larger share', () => {
    expect(detectLanguage('मुझे दो किलो चीनी चाहिए')).toBe('hi');
    expect(detectLanguage('namaste, mujhe chai chahiye')).toBe('en');       // Hinglish in Latin letters: English until the customer switches
    expect(detectLanguage('hello')).toBe('en');
    expect(detectLanguage('12345 👍')).toBe('en');
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('मुझे 2 sugar चाहिए')).toBe('hi');
    expect(detectLanguage('I want चीनी and tea and rice')).toBe('en');
  });
  it('recognises the switch words and nothing else', () => {
    expect(languageCommand('Hindi')).toBe('hi'); expect(languageCommand(' हिंदी ')).toBe('hi'); expect(languageCommand('english')).toBe('en');
    expect(languageCommand('i speak hindi')).toBeUndefined(); expect(languageCommand('catalog')).toBeUndefined();
  });
});

describe('the bot speaks the customer\'s language', () => {
  let t0: TestApp; let ids: Awaited<ReturnType<typeof seedCatalog>>;
  const say = (from: string, text: string, action?: string): Promise<BotReply> => t0.c.bot.handle({ channel: 'whatsapp', from, text, ...(action ? { action } : {}), senderName: 'x' } as InboundMessage);
  const titles = (r: BotReply) => (r.buttons ?? []).map((b) => b.title);

  beforeAll(async () => {
    t0 = await buildTestApp(); const staff = await t0.token('staff'); ids = await seedCatalog(t0, staff);
    await t0.c.stock.receive({ productId: ids.tee.id, warehouseId: ids.main.id, quantity: 5 }, null);
    await request(t0.app).get('/healthz');
  });
  afterAll(async () => { await t0.close(); });

  it('a first message in Devanagari starts a Hindi conversation and is remembered', async () => {
    const welcome = await say('919100000001', 'नमस्ते');
    expect(welcome.text).toMatch(/आपका स्वागत है/);
    expect(titles(welcome)).toEqual(['🛍 देखें', '🛒 मेरा कार्ट', '📦 मेरे ऑर्डर']);
    const cart = await say('919100000001', 'cart', 'cart');                                 // a tap with no Hindi text still answers in Hindi: it was stored
    expect(cart.text).toBe('आपका कार्ट खाली है।');
    expect((await t0.c.customers.findOrCreateByChannel('whatsapp', '919100000001', 'x')).language).toBe('hi');
  });

  it('an English first message starts English; the switch words and buttons change it both ways', async () => {
    expect((await say('919100000002', 'hello')).text).toMatch(/Welcome to/);
    const toHindi = await say('919100000002', 'hindi');
    expect(toHindi.text).toMatch(/^✅ भाषा हिंदी कर दी गई है।/);
    expect(titles(toHindi)).toContain('🛍 देखें');
    expect((await say('919100000002', 'cart', 'cart')).text).toBe('आपका कार्ट खाली है।');
    const back = await say('919100000002', 'x', 'lang:en');
    expect(back.text).toMatch(/^✅ Language set to English\./);
    expect((await say('919100000002', 'cart', 'cart')).text).toBe('Your cart is empty.');
  });

  it('the whole tap flow works in Hindi: browse, product, add, cart, checkout, order, my orders, order detail', async () => {
    const from = '919100000003';
    await say(from, 'हिंदी');
    const catalog = await say(from, 'catalog', 'catalog');
    const rowTitles = catalog.list!.sections[0]!.rows.map((r) => r.title);
    expect(catalog.text).toBeTruthy();
    const product = await say(from, 'x', `prod:${ids.tee.id}`);
    expect(product.text).toContain('आपको कितने चाहिए?');
    expect(product.text).toContain('5 स्टॉक में');
    const added = await say(from, '2', `qty:${ids.tee.id}:2`);
    expect(added.text).toContain('✅ 2 × T-Shirt आपके कार्ट में जोड़ दिया गया।');
    expect(added.text).toContain('🛒 कार्ट: 2 वस्तुएँ');
    expect(titles(added)).toEqual(['🧾 चेकआउट', '🛍 और खरीदें', '🗑 कार्ट खाली करें']);
    const checkout = await say(from, 'x', 'checkout');
    expect(checkout.text).toContain('*चेकआउट*'); expect(checkout.text).toContain('आप कैसे भुगतान करना चाहेंगे?');
    const placed = await say(from, 'x', 'pay:cod');
    expect(placed.text).toMatch(/^✅ ऑर्डर #\d+ हो गया — डिलीवरी पर भुगतान।/);
    const orders = await say(from, 'x', 'orders');
    expect(orders.text).toBe('📦 आपके हाल के ऑर्डर:');
    expect(orders.list!.sections[0]!.rows[0]!.title).toMatch(/· लंबित$/);
    const detail = await say(from, 'x', orders.list!.sections[0]!.rows[0]!.id);
    expect(detail.text).toContain('स्थिति: लंबित'); expect(detail.text).toContain('भुगतान: डिलीवरी पर भुगतान · बाकी');
    expect(rowTitles.length).toBeGreaterThan(0);
  });

  it('errors and the always-available switch are translated too, and English output is unchanged', async () => {
    const sorry = await say('919100000004', 'hi', 'prod:00000000-0000-4000-8000-000000000000');
    expect(sorry.text).toBe('Sorry — That product no longer exists.');
    expect(titles(sorry)).toEqual(['🛍 Browse', '🏠 Menu', '🌐 हिंदी']);
    await say('919100000004', 'hindi');
    const sorryHi = await say('919100000004', 'x', 'prod:00000000-0000-4000-8000-000000000000');
    expect(sorryHi.text).toBe('क्षमा करें — यह उत्पाद अब उपलब्ध नहीं है।');
    expect(titles(sorryHi)).toEqual(['🛍 देखें', '🏠 मेन्यू', '🌐 English']);
  });

  it('customers do not affect each other\'s language', async () => {
    await say('919100000005', 'हिंदी'); await say('919100000006', 'english');
    expect((await say('919100000005', 'x', 'cart')).text).toBe('आपका कार्ट खाली है।');
    expect((await say('919100000006', 'x', 'cart')).text).toBe('Your cart is empty.');
  });

  it('a signed-in user\'s interface language is saved on the server and follows them (per user)', async () => {
    const a = await t0.token('admin'); const b = await t0.token('staff');
    const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
    expect((await request(t0.app).get('/api/auth/me').set(h(a))).body.language).toBe('en');       // the default
    expect((await request(t0.app).patch('/api/auth/language').set(h(a)).send({ language: 'hi' })).body).toEqual({ language: 'hi' });
    expect((await request(t0.app).get('/api/auth/me').set(h(a))).body.language).toBe('hi');
    expect((await request(t0.app).get('/api/auth/me').set(h(b))).body.language).toBe('en');       // another user is not affected
    expect((await request(t0.app).patch('/api/auth/language').set(h(a)).send({ language: 'fr' })).status).toBe(400);
    expect((await request(t0.app).patch('/api/auth/language').set(h(a)).send({ language: 'hi', extra: 1 })).status).toBe(400);
    expect((await request(t0.app).patch('/api/auth/language').send({ language: 'hi' })).status).toBe(401);
  });
});
