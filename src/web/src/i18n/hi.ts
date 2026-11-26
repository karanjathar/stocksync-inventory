import type { Key } from './en';

export const hi: Record<Key, string> = {
  'lang.label': 'भाषा',
  'nav.dashboard': 'डैशबोर्ड', 'nav.products': 'उत्पाद', 'nav.inventory': 'इन्वेंटरी', 'nav.stockCounts': 'स्टॉक गिनती', 'nav.movements': 'स्टॉक हलचल', 'nav.orders': 'ऑर्डर',
  'nav.purchasing': 'खरीद', 'nav.inbox': 'इनबॉक्स', 'nav.customers': 'ग्राहक', 'nav.suppliers': 'आपूर्तिकर्ता', 'nav.warehouses': 'गोदाम', 'nav.settings': 'सेटिंग्स',
  'nav.users': 'उपयोगकर्ता', 'nav.analytics': 'विश्लेषण', 'nav.assistant': 'सहायक', 'nav.activity': 'गतिविधि लॉग', 'nav.usage': 'प्लान और उपयोग', 'nav.publicShop': 'सार्वजनिक दुकान',
  'shell.toggleMenu': 'मेन्यू खोलें/बंद करें', 'shell.signOut': 'साइन आउट',
  'login.title': 'साइन इन', 'login.intro': 'अपनी इन्वेंटरी संभालने के लिए साइन इन करें।', 'login.email': 'ईमेल', 'login.password': 'पासवर्ड', 'login.submit': 'साइन इन', 'login.busy': 'साइन इन हो रहा है…',
  'login.newHere': 'नए हैं? व्यापार खाता बनाएँ', 'login.visitShop': 'दुकान देखें →',
  'signup.title': 'अपना खाता बनाएँ', 'signup.intro': 'अपना व्यापार खाता बनाएँ। शुरुआत मुफ़्त है।', 'signup.businessName': 'व्यापार का नाम', 'signup.webAddress': 'वेब पता',
  'signup.shopWillLive': 'आपकी दुकान /shop/{slug} पर होगी', 'signup.yourName': 'आपका नाम', 'signup.password': 'पासवर्ड', 'signup.passwordHint': 'कम से कम 10 अक्षर।',
  'signup.submit': 'खाता बनाएँ', 'signup.busy': 'बन रहा है…', 'signup.haveAccount': 'पहले से खाता है? साइन इन करें',
  'signup.checkEmail': 'अपना ईमेल देखें', 'signup.sentTo': 'यदि विवरण सही हैं, तो हमने {email} पर पुष्टि लिंक भेजा है। यह एक बार काम करता है और 24 घंटे में समाप्त हो जाता है।',
  'signup.resend': 'लिंक दोबारा भेजें', 'signup.resent': 'दोबारा भेजा गया (यदि अनुमति हो)', 'signup.backToSignIn': 'साइन इन पर वापस जाएँ',
  'verify.working': 'आपका ईमेल पुष्ट हो रहा है…', 'verify.done': 'सब तैयार है', 'verify.ready': 'आपका व्यापार /shop/{slug} पर तैयार है।', 'verify.signIn': 'साइन इन',
  'verify.failed': 'हम वह लिंक पुष्ट नहीं कर सके', 'verify.startAgain': 'फिर से शुरू करें', 'verify.incomplete': 'यह लिंक अधूरा है।',
  'shop.title': 'दुकान', 'shop.searchLabel': 'उत्पाद खोजें', 'shop.searchPlaceholder': 'खोजें…', 'shop.viewCart': 'कार्ट देखें ({n} वस्तुएँ)', 'shop.unpaid': '⏳ आपका एक ऑर्डर अभी भुगतान के लिए बाकी है।',
  'shop.continuePayment': 'ऑर्डर #{n} का भुगतान जारी रखें', 'shop.noProducts': 'कोई उत्पाद नहीं मिला।', 'shop.inStock': '{n} स्टॉक में', 'shop.outOfStock': 'स्टॉक में नहीं', 'shop.add': 'कार्ट में जोड़ें',
  'shop.addLabel': '{name} कार्ट में जोड़ें', 'shop.cart': 'कार्ट', 'shop.yourCart': 'आपका कार्ट', 'shop.removeOne': '{name} एक कम करें', 'shop.total': 'कुल', 'shop.yourName': 'आपका नाम',
  'shop.phone': 'फ़ोन (WhatsApp)', 'shop.payment': 'भुगतान', 'shop.payOnline': 'ऑनलाइन भुगतान (UPI / कार्ड)', 'shop.cod': 'डिलीवरी पर भुगतान', 'shop.willPayOnline': '💳 आप ऑनलाइन भुगतान करेंगे (UPI / कार्ड)।',
  'shop.willPayCod': '💵 डिलीवरी पर नकद भुगतान करें।', 'shop.unavailable': 'ऑर्डर अभी अस्थायी रूप से उपलब्ध नहीं हैं। कृपया बाद में कोशिश करें', 'shop.orWhatsApp': ' या WhatsApp पर ऑर्डर करें',
  'shop.placeOrder': 'ऑर्डर करें', 'shop.orderOnWhatsApp': '💬 या WhatsApp पर ऑर्डर करें', 'shop.cartEmpty': 'आपका कार्ट खाली है।',
};
