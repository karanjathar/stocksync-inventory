import { AsyncLocalStorage } from 'node:async_hooks';

export type Lang = 'en' | 'hi';
export const LANGS: Lang[] = ['en', 'hi'];

/** English is the source of truth: every key must exist in Hindi too (a test enforces it, and so does the type below). `{name}` marks a value filled in at run time. */
export const en = {
  'btn.browse': '🛍 Browse', 'btn.cart': '🛒 My cart', 'btn.orders': '📦 My orders', 'btn.checkout': '🧾 Checkout', 'btn.keep': '🛍 Keep shopping',
  'btn.clear': '🗑 Clear cart', 'btn.menu': '🏠 Menu', 'btn.edit': '✏️ Edit cart', 'btn.payOnline': '💳 Pay online', 'btn.cod': '💵 Cash on delivery',
  'btn.switchLang': '🌐 हिंदी', 'row.switchLang': '🌐 हिंदी में देखें',
  'lang.set': '✅ Language set to English.',
  'menu.welcome': '👋 Welcome to {name}! Tap a button to shop. (You can also type "help" for text commands. हिंदी के लिए "hindi" लिखें।)',
  'catalog.restocking': 'Our shelves are being restocked — please check back soon!', 'catalog.ask': 'What are you looking for?', 'catalog.categories': 'Categories', 'catalog.all': 'All products',
  'count.product.one': '{n} product', 'count.product.other': '{n} products', 'count.item.one': '{n} item', 'count.item.other': '{n} items',
  'category.gone': 'That category no longer exists.', 'category.empty': 'Nothing available here right now.', 'category.pick': '{name} — pick a product:', 'category.products': 'Products',
  'row.left': '{price} · {n} left', 'more.title': 'More…', 'more.desc': 'Show {n} more',
  'product.gone': 'That product no longer exists.', 'product.unavailable': '{name} is not available right now.', 'product.line': '{price} per {unit} · {n} in stock',
  'product.howMany': 'How many would you like?', 'product.quantity': 'Quantity', 'product.chooseQty': 'Choose quantity',
  'cart.added': '✅ Added {n} × {name} to your cart.', 'cart.already': 'Your cart already has all available {name}.', 'cart.capped': '(We have only {n} available.)',
  'cart.summary': '🛒 Cart: {items} · {total}', 'cart.title': '🛒 *Your cart*', 'cart.total': '*Total: {total}*', 'cart.cleared': '🗑 Cart cleared.', 'cart.empty': 'Your cart is empty.',
  'cart.changedEmpty': 'Some items changed since you added them (no longer available). ', 'cart.changed': '⚠️ Some items changed since you added them (stock or availability).',
  'checkout.changed': '⚠️ Some items changed since you added them — please check:', 'checkout.title': '🧾 *Checkout*', 'checkout.how': 'How would you like to pay?',
  'checkout.paused': 'ordering is paused right now. Please try again later.',
  'pay.onlineUnavailable': 'online payment is not available right now. You can choose Cash on delivery at checkout.', 'pay.codUnavailable': 'cash on delivery is not available. Please pay online at checkout.',
  'order.placedCod': '✅ Order #{n} placed — Cash on delivery.\nTotal: {total}\nWe\'ll confirm shortly.',
  'orders.none': 'You have no orders yet.', 'orders.recent': '📦 Your recent orders:', 'orders.button': 'My orders', 'orders.section': 'Recent orders',
  'order.title': '*Order #{n}*', 'order.status': 'Status: {s}', 'order.payment': 'Payment: {method} · {state}', 'order.total': 'Total: {total}', 'order.notFound': 'we couldn\'t find that order.',
  'status.PENDING': 'Pending', 'status.CONFIRMED': 'Confirmed', 'status.FULFILLED': 'Fulfilled', 'status.CANCELLED': 'Cancelled',
  'method.COD': 'Cash on delivery', 'method.ONLINE': 'Online',
  'paystate.UNPAID': 'unpaid', 'paystate.PAID': 'paid ✅', 'paystate.REFUND_DUE': 'refund due', 'paystate.REFUNDED': 'refunded',
  'paylink.cancelled': 'Order #{n} was cancelled, so there is nothing to pay.', 'paylink.paid': '✅ Order #{n} is already paid. Thank you!',
  'paylink.refundDue': 'We received a payment for order #{n} and a refund is being arranged.', 'paylink.refunded': 'Your payment for order #{n} has been refunded.',
  'paylink.cod': 'Order #{n} is cash on delivery — nothing to pay online.',
  'sorry.prefix': 'Sorry — {message}', 'sorry.invalidOption': 'That option is no longer valid.',
  'bot.welcome': '👋 Welcome to {name}! You can send:', 'bot.help.catalog': '• catalog — see what is in stock', 'bot.help.stock': '• stock <SKU> — check availability',
  'bot.help.price': '• price <SKU> — check the price', 'bot.help.order': '• order <SKU> <qty> — place an order', 'bot.help.status': '• status <order#> — track your order',
  'bot.help.lang': '• hindi / english — change language',
  'ai.choose': 'Which one do you mean? Tap to choose 👇', 'ai.choose.button': 'Choose', 'ai.choose.section': 'Options',
} as const;

export type MessageKey = keyof typeof en;

export const hi: Record<MessageKey, string> = {
  'btn.browse': '🛍 देखें', 'btn.cart': '🛒 मेरा कार्ट', 'btn.orders': '📦 मेरे ऑर्डर', 'btn.checkout': '🧾 चेकआउट', 'btn.keep': '🛍 और खरीदें',
  'btn.clear': '🗑 कार्ट खाली करें', 'btn.menu': '🏠 मेन्यू', 'btn.edit': '✏️ कार्ट बदलें', 'btn.payOnline': '💳 ऑनलाइन भुगतान', 'btn.cod': '💵 डिलीवरी पर भुगतान',
  'btn.switchLang': '🌐 English', 'row.switchLang': '🌐 View in English',
  'lang.set': '✅ भाषा हिंदी कर दी गई है।',
  'menu.welcome': '👋 {name} में आपका स्वागत है! खरीदारी के लिए बटन दबाएँ। (टेक्स्ट कमांड के लिए "help" लिखें। For English, type "english".)',
  'catalog.restocking': 'हमारी अलमारियाँ दोबारा भरी जा रही हैं — कृपया थोड़ी देर बाद देखें!', 'catalog.ask': 'आप क्या ढूँढ रहे हैं?', 'catalog.categories': 'श्रेणियाँ', 'catalog.all': 'सभी उत्पाद',
  'count.product.one': '{n} उत्पाद', 'count.product.other': '{n} उत्पाद', 'count.item.one': '{n} वस्तु', 'count.item.other': '{n} वस्तुएँ',
  'category.gone': 'यह श्रेणी अब उपलब्ध नहीं है।', 'category.empty': 'यहाँ अभी कुछ उपलब्ध नहीं है।', 'category.pick': '{name} — कोई उत्पाद चुनें:', 'category.products': 'उत्पाद',
  'row.left': '{price} · {n} बचे हैं', 'more.title': 'और देखें…', 'more.desc': '{n} और दिखाएँ',
  'product.gone': 'यह उत्पाद अब उपलब्ध नहीं है।', 'product.unavailable': '{name} अभी उपलब्ध नहीं है।', 'product.line': '{price} प्रति {unit} · {n} स्टॉक में',
  'product.howMany': 'आपको कितने चाहिए?', 'product.quantity': 'मात्रा', 'product.chooseQty': 'मात्रा चुनें',
  'cart.added': '✅ {n} × {name} आपके कार्ट में जोड़ दिया गया।', 'cart.already': 'आपके कार्ट में {name} की पूरी उपलब्ध मात्रा पहले से है।', 'cart.capped': '(हमारे पास केवल {n} उपलब्ध हैं।)',
  'cart.summary': '🛒 कार्ट: {items} · {total}', 'cart.title': '🛒 *आपका कार्ट*', 'cart.total': '*कुल: {total}*', 'cart.cleared': '🗑 कार्ट खाली कर दिया गया।', 'cart.empty': 'आपका कार्ट खाली है।',
  'cart.changedEmpty': 'जोड़ने के बाद कुछ वस्तुएँ बदल गईं (अब उपलब्ध नहीं)। ', 'cart.changed': '⚠️ जोड़ने के बाद कुछ वस्तुएँ बदल गईं (स्टॉक या उपलब्धता)।',
  'checkout.changed': '⚠️ जोड़ने के बाद कुछ वस्तुएँ बदल गईं — कृपया जाँच लें:', 'checkout.title': '🧾 *चेकआउट*', 'checkout.how': 'आप कैसे भुगतान करना चाहेंगे?',
  'checkout.paused': 'ऑर्डर अभी रुके हुए हैं। कृपया बाद में कोशिश करें।',
  'pay.onlineUnavailable': 'ऑनलाइन भुगतान अभी उपलब्ध नहीं है। आप चेकआउट पर डिलीवरी पर भुगतान चुन सकते हैं।', 'pay.codUnavailable': 'डिलीवरी पर भुगतान उपलब्ध नहीं है। कृपया चेकआउट पर ऑनलाइन भुगतान करें।',
  'order.placedCod': '✅ ऑर्डर #{n} हो गया — डिलीवरी पर भुगतान।\nकुल: {total}\nहम जल्द ही पुष्टि करेंगे।',
  'orders.none': 'आपका अभी कोई ऑर्डर नहीं है।', 'orders.recent': '📦 आपके हाल के ऑर्डर:', 'orders.button': 'मेरे ऑर्डर', 'orders.section': 'हाल के ऑर्डर',
  'order.title': '*ऑर्डर #{n}*', 'order.status': 'स्थिति: {s}', 'order.payment': 'भुगतान: {method} · {state}', 'order.total': 'कुल: {total}', 'order.notFound': 'हमें वह ऑर्डर नहीं मिला।',
  'status.PENDING': 'लंबित', 'status.CONFIRMED': 'पुष्टि हो गई', 'status.FULFILLED': 'पूरा हुआ', 'status.CANCELLED': 'रद्द',
  'method.COD': 'डिलीवरी पर भुगतान', 'method.ONLINE': 'ऑनलाइन',
  'paystate.UNPAID': 'बाकी', 'paystate.PAID': 'चुकाया ✅', 'paystate.REFUND_DUE': 'रिफंड बाकी', 'paystate.REFUNDED': 'रिफंड हो गया',
  'paylink.cancelled': 'ऑर्डर #{n} रद्द हो गया था, इसलिए कुछ चुकाना नहीं है।', 'paylink.paid': '✅ ऑर्डर #{n} का भुगतान हो चुका है। धन्यवाद!',
  'paylink.refundDue': 'ऑर्डर #{n} का भुगतान मिला है और रिफंड की व्यवस्था की जा रही है।', 'paylink.refunded': 'ऑर्डर #{n} का आपका भुगतान लौटा दिया गया है।',
  'paylink.cod': 'ऑर्डर #{n} डिलीवरी पर भुगतान का है — ऑनलाइन कुछ चुकाना नहीं है।',
  'sorry.prefix': 'क्षमा करें — {message}', 'sorry.invalidOption': 'यह विकल्प अब मान्य नहीं है।',
  'bot.welcome': '👋 {name} में आपका स्वागत है! आप ये भेज सकते हैं:', 'bot.help.catalog': '• catalog — स्टॉक में क्या है देखें', 'bot.help.stock': '• stock <SKU> — उपलब्धता जाँचें',
  'bot.help.price': '• price <SKU> — कीमत जाँचें', 'bot.help.order': '• order <SKU> <मात्रा> — ऑर्डर करें', 'bot.help.status': '• status <ऑर्डर#> — ऑर्डर ट्रैक करें',
  'bot.help.lang': '• hindi / english — भाषा बदलें',
  'ai.choose': 'आप कौन सा लेना चाहते हैं? चुनने के लिए दबाएँ 👇', 'ai.choose.button': 'चुनें', 'ai.choose.section': 'विकल्प',
};

const catalogs: Record<Lang, Record<MessageKey, string>> = { en, hi };
const store = new AsyncLocalStorage<Lang>();

/** Runs `fn` so that every `t()` inside (however deep, however async) answers in `lang`. Safe for concurrent requests. */
export const runWithLang = <T>(lang: Lang, fn: () => T): T => store.run(lang, fn);
export const currentLang = (): Lang => store.getStore() ?? 'en';

export function translate(lang: Lang, key: MessageKey, params: Record<string, string | number> = {}): string {
  const text = catalogs[lang][key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
export const t = (key: MessageKey, params?: Record<string, string | number>): string => translate(currentLang(), key, params);
/** "3 products" / "1 product": one form for singular, one for everything else (Hindi uses the same form for both). */
export const count = (kind: 'product' | 'item', n: number): string => t(`count.${kind}.${n === 1 ? 'one' : 'other'}` as MessageKey, { n });

/** The first message decides: mostly Devanagari letters means Hindi, anything else English. A customer can always switch (hindi / english, or the language button). */
export function detectLanguage(text: string): Lang {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return 'en';
  const deva = letters.filter((c) => /[ऀ-ॿ]/.test(c)).length;
  return deva / letters.length >= 0.3 ? 'hi' : 'en';
}

/** Words that switch language when sent on their own. */
export function languageCommand(text: string): Lang | undefined {
  const s = text.trim().toLowerCase();
  if (['hindi', 'हिंदी', 'हिन्दी', 'hindi me', 'hindi mein'].includes(s)) return 'hi';
  if (['english', 'अंग्रेज़ी', 'अंग्रेजी', 'angrezi'].includes(s)) return 'en';
  return undefined;
}
