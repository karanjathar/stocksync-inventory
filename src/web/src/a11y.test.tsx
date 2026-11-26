import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import axe from 'axe-core';
import { AuthProvider } from './auth';
import { SettingsProvider } from './settings';
import { I18nProvider } from './i18n';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Signup, VerifyEmail } from './pages/Signup';
import { Shop } from './pages/Shop';
import { ShopOrder } from './pages/ShopOrder';
import { Dashboard } from './pages/Dashboard';
import { Products } from './pages/Products';
import { Inventory } from './pages/Inventory';
import { Movements } from './pages/Movements';
import { StockCounts } from './pages/StockCounts';
import { Customers, Suppliers, Warehouses } from './pages/Parties';
import { Orders } from './pages/Orders';
import { PurchaseOrders } from './pages/PurchaseOrders';
import { Inbox } from './pages/Inbox';
import { SettingsPage } from './pages/SettingsPage';
import { Users } from './pages/Users';
import { Account } from './pages/Account';
import { Analytics } from './pages/Analytics';
import { Assistant } from './pages/Assistant';
import { Usage } from './pages/Usage';
import { AuditLog } from './pages/AuditLog';
import { Platform } from './pages/Platform';
import { mockApi } from './test/setup';

/**
 * Automated accessibility checks (axe-core, WCAG 2.2 A and AA rules that a DOM test can evaluate) on every page, in English and Hindi, plus the
 * app shell. Colour contrast needs real layout, so it is checked separately from the design tokens (contrast.test.ts). The manual checks axe
 * cannot do (focus order, zoom, screen readers) are in docs/DEPLOYMENT_GUIDE.md.
 */
const admin = { id: 'u1', email: 'a@b.c', name: 'Ann', role: 'admin', language: 'en', createdAt: '2026-01-01T00:00:00Z' };
const settings = { businessName: 'Corner Shop', currency: 'INR', whatsappNumber: '', defaultWarehouseId: null, alertRecipients: [], customFields: [], payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 },
  whatsappTemplates: {}, maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 365 }, gst: { legalName: '', gstin: '', address: '', stateCode: '', invoicePrefix: 'INV', pricesIncludeTax: true } };
const product = { id: 'p1', sku: 'TEE', name: 'T-Shirt', description: 'Soft', categoryId: null, unit: 'pcs', priceCents: 49900, reorderLevel: 5, imageUrl: null, barcode: null, hsnCode: null, gstRateBp: null, attributes: {}, isActive: true, totalQuantity: 7, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const order = { id: 'o1', number: 1, customerId: 'c1', customerName: 'Priya', channel: 'whatsapp', status: 'PENDING', warehouseId: null, totalCents: 49900, notes: '', paymentMethod: 'COD', paymentStatus: 'UNPAID', publicToken: 't', items: [{ productId: 'p1', name: 'T-Shirt', sku: 'TEE', quantity: 1, unitPriceCents: 49900 }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const lists: Record<string, unknown> = {
  '/products': [product], '/warehouses': [{ id: 'w1', code: 'MAIN', name: 'Main', address: '' }], '/customers': [{ id: 'c1', name: 'Priya', phone: '+919000000000', email: null, channel: 'whatsapp', channelUserId: null, gstin: null, stateCode: null }],
  '/suppliers': [{ id: 's1', name: 'Acme', email: null, phone: null, notes: '', leadTimeDays: 7 }], '/categories': [], '/orders': [order], '/purchase-orders': [], '/stock': [], '/stock/movements': [], '/users': [admin],
  '/stock-counts': [], '/messages': [], '/channels': [],
};
const routes = new Proxy({} as Record<string, unknown>, { get: (_t, raw: string) => {
  const key = raw.split('?')[0]!;
  if (key === '/auth/me') return admin;
  if (key === '/settings') return settings;
  if (key === '/dashboard') return { productCount: 1, totalUnits: 7, stockValueCents: 349300, lowStockCount: 0, pendingOrders: 1, ordersToday: 0 };
  if (key in lists) return lists[key];
  if (key.startsWith('/reorder-suggestions')) return { suggestions: [] };
  if (key === '/ops/status') return { queue: { pending: 0, running: 0, dead: 0, oldestPendingSec: 0 }, messages: { failed24h: 0, queued: 0 }, maintenance: [] };
  if (key === '/payments/config') return { onlineAvailable: false, codEnabled: true, razorpayConfigured: false };
  if (key === '/channel-config') return { tenantId: 't', enabled: false, urls: { meta: '', telegram: '', razorpay: '' }, kinds: [] };
  if (key === '/onboarding') return { steps: [], dismissed: true, demo: false, complete: true };
  if (key === '/billing') return { configured: false, plan: { code: 'FREE', name: 'Free' }, subscription: null, trialDays: 14, trialAvailable: true, offers: [] };
  if (key === '/data/deletion') return { slug: 'corner', requested: false, requestedAt: null, eraseAfter: null, holdDays: 30 };
  if (key === '/usage') return { plan: { code: 'FREE', name: 'Free', priceMinor: 0, currency: 'INR', maxProducts: 50, maxUsers: 2, maxChatMessages: 200, maxInvoices: 20 }, period: '2026-11', usage: { products: 1, users: 1, chatMessages: 0, invoices: 0 } };
  if (key === '/audit-log') return { entries: [{ id: 'e1', at: '2026-01-01T00:00:00Z', actor: 'a@b.c', action: 'PUT /settings', entityId: null, detail: { fields: ['currency'] } }], next: null };
  if (key === '/assistant/status') return { available: true };
  if (key.startsWith('/analytics/sales')) return { range: { from: '2026-01-01', to: '2026-01-02' }, days: [{ day: '2026-01-01', orders: 1, units: 1, revenueCents: 49900 }, { day: '2026-01-02', orders: 0, units: 0, revenueCents: 0 }], totals: { orders: 1, units: 1, revenueCents: 49900 }, byChannel: [{ channel: 'whatsapp', orders: 1, revenueCents: 49900 }] };
  if (key.startsWith('/analytics/best-sellers')) return { products: [{ sku: 'TEE', name: 'T-Shirt', units: 1, revenueCents: 49900 }] };
  if (key.startsWith('/analytics/margins')) return { products: [], totals: { revenueCents: 0, costCents: 0, marginCents: 0, marginPct: null, unknownCostProducts: 0 } };
  if (key.startsWith('/analytics/funnel')) return { conversations: 2, orders: 1, confirmed: 1, paid: 0, rates: { conversationToOrder: 0.5, orderToConfirmed: 1, confirmedToPaid: 0 } };
  if (key.startsWith('/analytics/dead-stock')) return { days: 60, products: [] };
  if (key === '/public/catalog' || key.startsWith('/public/s/')) return { settings: { businessName: 'Corner Shop', currency: 'INR', whatsappNumber: '919000000000', paymentMethods: ['COD'] }, products: [{ id: 'p1', sku: 'TEE', name: 'T-Shirt', description: 'Soft', priceCents: 49900, unit: 'pcs', imageUrl: null, attributes: { size: 'M' }, categoryId: null, inStock: true, available: 7 }] };
  if (key.startsWith('/public/orders/')) return { shop: 'corner', invoiceAvailable: false, number: 1, status: 'PENDING', paymentMethod: 'COD', paymentStatus: 'UNPAID', totalCents: 49900, currency: 'INR', items: [{ name: 'T-Shirt', quantity: 1 }] };
  if (key === '/platform/tenants') return [];
  return undefined;
} });

function Providers({ children, path = '/' }: { children: ReactNode; path?: string }) {
  return <AuthProvider><I18nProvider><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></I18nProvider></AuthProvider>;
}

/** Runs axe on what is rendered and fails with a readable list of every violation. */
async function expectNoViolations(container: HTMLElement, opts: { region?: boolean } = {}) {
  const result = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: opts.region ?? false }, 'landmark-one-main': { enabled: opts.region ?? false }, 'page-has-heading-one': { enabled: false } },
  });
  const report = result.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 3).map((n) => `    ${n.html.slice(0, 140)}`).join('\n')}`).join('\n');
  expect(report, `accessibility violations:\n${report}`).toBe('');
}

const PAGES: [string, ReactNode, string][] = [
  ['Sign in', <Login />, '/login'], ['Sign up', <Signup />, '/signup'], ['Verify e-mail', <VerifyEmail />, '/verify-email?token=abc'],
  ['Shop', <Shop />, '/shop'], ['Shop order', <ShopOrder />, '/shop/order/tok'],
  ['Dashboard', <Dashboard />, '/'], ['Products', <Products />, '/products'], ['Inventory', <Inventory />, '/inventory'], ['Movements', <Movements />, '/movements'], ['Stock counts', <StockCounts />, '/stock-counts'],
  ['Customers', <Customers />, '/customers'], ['Suppliers', <Suppliers />, '/suppliers'], ['Warehouses', <Warehouses />, '/warehouses'], ['Orders', <Orders />, '/orders'], ['Purchasing', <PurchaseOrders />, '/purchase-orders'],
  ['Inbox', <Inbox />, '/inbox'], ['Settings', <SettingsPage />, '/settings'], ['Users', <Users />, '/users'], ['Account', <Account />, '/account'],
  ['Analytics', <Analytics />, '/analytics'], ['Assistant', <Assistant />, '/assistant'], ['Plan and usage', <Usage />, '/usage'], ['Activity log', <AuditLog />, '/activity'], ['Platform console', <Platform />, '/platform'],
];
const routePattern: Record<string, string> = { '/shop/order/tok': '/shop/order/:token', '/verify-email?token=abc': '/verify-email' };

afterEach(() => { localStorage.clear(); document.cookie = 'ss_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; });

describe.each(['en', 'hi'] as const)('accessibility (%s)', (lang) => {
  it.each(PAGES)('%s has no axe violations', async (name, page, path) => {
    localStorage.setItem('stocksync.lang', lang);
    document.cookie = 'ss_csrf=test; path=/'; // a session exists, so the shell loads the user
    mockApi(routes);
    const pattern = routePattern[path] ?? path.split('?')[0]!;
    const { container } = render(<Providers path={path}><SettingsProvider><Routes><Route path={pattern} element={page} /></Routes></SettingsProvider></Providers>);
    await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(10));
    await new Promise((r) => setTimeout(r, 60)); // let the page's own requests settle
    await expectNoViolations(container);
  }, 20_000);
});

describe('the app shell', () => {
  it('has real landmarks (navigation, banner, main), a skip link as the first focusable element, and no violations', async () => {
    document.cookie = 'ss_csrf=test; path=/';
    mockApi(routes);
    const { container } = render(
      <Providers><SettingsProvider><Routes><Route element={<Layout />}><Route index element={<h1>Dashboard</h1>} /></Route></Routes></SettingsProvider></Providers>);
    await screen.findByRole('navigation');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    const skip = screen.getByRole('link', { name: /skip to (main )?content/i });
    expect(skip).toHaveAttribute('href', '#main');
    expect(container.querySelector('main')).toHaveAttribute('id', 'main');
    expect(container.querySelector('a, button, input, select, textarea')).toBe(skip);          // first thing a keyboard user reaches
    await expectNoViolations(container, { region: true });
  });

  it('the menu button reports whether the menu is open', async () => {
    document.cookie = 'ss_csrf=test; path=/';
    mockApi(routes);
    function Wrapper() { const [x] = useState(0); void x; return <Providers><SettingsProvider><Routes><Route element={<Layout />}><Route index element={<h1>Dashboard</h1>} /></Route></Routes></SettingsProvider></Providers>; }
    render(<Wrapper />);
    const button = await screen.findByRole('button', { name: /toggle menu/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });
});
