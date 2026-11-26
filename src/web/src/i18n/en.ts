/** English is the source of truth. Hindi (hi.ts) must have exactly these keys (the type and a test enforce it). `{name}` marks a value filled in at run time. */
export const en = {
  'lang.label': 'Language',
  // navigation and shell
  'nav.dashboard': 'Dashboard', 'nav.products': 'Products', 'nav.inventory': 'Inventory', 'nav.stockCounts': 'Stock counts', 'nav.movements': 'Movements', 'nav.orders': 'Orders',
  'nav.purchasing': 'Purchasing', 'nav.inbox': 'Inbox', 'nav.customers': 'Customers', 'nav.suppliers': 'Suppliers', 'nav.warehouses': 'Warehouses', 'nav.settings': 'Settings',
  'nav.users': 'Users', 'nav.analytics': 'Analytics', 'nav.assistant': 'Assistant', 'nav.activity': 'Activity log', 'nav.usage': 'Plan & usage', 'nav.publicShop': 'Public shop',
  'shell.toggleMenu': 'Toggle menu', 'shell.signOut': 'Sign out',
  // sign in / sign up
  'login.title': 'Sign in', 'login.intro': 'Sign in to manage your inventory.', 'login.email': 'Email', 'login.password': 'Password', 'login.submit': 'Sign in', 'login.busy': 'Signing in…',
  'login.newHere': 'New here? Create a business account', 'login.visitShop': 'Visit the shop →',
  'signup.title': 'Create your account', 'signup.intro': 'Create your business account. Free to start.', 'signup.businessName': 'Business name', 'signup.webAddress': 'Web address',
  'signup.shopWillLive': 'Your shop will live at /shop/{slug}', 'signup.yourName': 'Your name', 'signup.password': 'Password', 'signup.passwordHint': 'At least 10 characters.',
  'signup.submit': 'Create account', 'signup.busy': 'Creating…', 'signup.haveAccount': 'Already have an account? Sign in',
  'signup.checkEmail': 'Check your email', 'signup.sentTo': 'If the details are valid, we sent a confirmation link to {email}. It works once and expires in 24 hours.',
  'signup.resend': 'Send the link again', 'signup.resent': 'Sent again (if allowed)', 'signup.backToSignIn': 'Back to sign in',
  'verify.working': 'Confirming your email…', 'verify.done': 'You\'re all set', 'verify.ready': 'Your business is ready at /shop/{slug}.', 'verify.signIn': 'Sign in',
  'verify.failed': 'We couldn\'t confirm that link', 'verify.startAgain': 'Start again', 'verify.incomplete': 'This link is incomplete.',
  // storefront
  'shop.title': 'Shop', 'shop.searchLabel': 'Search products', 'shop.searchPlaceholder': 'Search…', 'shop.viewCart': 'View cart ({n} items)', 'shop.unpaid': '⏳ You have an unpaid order.',
  'shop.continuePayment': 'Continue payment for order #{n}', 'shop.noProducts': 'No products found.', 'shop.inStock': '{n} in stock', 'shop.outOfStock': 'Out of stock', 'shop.add': 'Add to cart',
  'shop.addLabel': 'Add {name} to cart', 'shop.cart': 'Cart', 'shop.yourCart': 'Your cart', 'shop.removeOne': 'Remove one {name}', 'shop.total': 'Total', 'shop.yourName': 'Your name',
  'shop.phone': 'Phone (WhatsApp)', 'shop.payment': 'Payment', 'shop.payOnline': 'Pay online (UPI / cards)', 'shop.cod': 'Cash on delivery', 'shop.willPayOnline': '💳 You will pay online (UPI / cards).',
  'shop.willPayCod': '💵 Pay cash on delivery.', 'shop.unavailable': 'Ordering is temporarily unavailable. Please try again later', 'shop.orWhatsApp': ' or order on WhatsApp',
  'shop.placeOrder': 'Place order', 'shop.orderOnWhatsApp': '💬 Or order on WhatsApp', 'shop.cartEmpty': 'Your cart is empty.',
} as const;
export type Key = keyof typeof en;
