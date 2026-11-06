import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Shop } from './Shop';
import { mockApi } from '../test/setup';

const redirectTo = vi.fn();
vi.mock('../redirect', async (orig) => ({ ...(await orig<typeof import('../redirect')>()), redirectTo: (url: string) => redirectTo(url) }));

const catalog = (paymentMethods: string[] = ['ONLINE', 'COD']) => ({
  settings: { businessName: 'Corner Shop', currency: 'USD', whatsappNumber: '+1 555 000 1234', paymentMethods },
  products: [
    { id: 'p1', sku: 'TEE', name: 'T-Shirt', description: 'Cotton tee', priceCents: 1500, unit: 'pcs', imageUrl: null, attributes: { color: 'red' }, categoryId: null, inStock: true, available: 3 },
    { id: 'p2', sku: 'MUG', name: 'Mug', description: '', priceCents: 800, unit: 'pcs', imageUrl: null, attributes: {}, categoryId: null, inStock: false, available: 0 },
  ],
});

function renderShop() {
  return render(
    <MemoryRouter initialEntries={['/shop']}>
      <Routes>
        <Route path="/shop" element={<Shop />} />
        <Route path="/shop/order/:token" element={<p>Order page for token</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillCheckout() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add T-Shirt to cart' }));
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mia' } });
  fireEvent.change(screen.getByLabelText('Phone (WhatsApp)'), { target: { value: '+15550007777' } });
}

beforeEach(() => { redirectTo.mockClear(); });

describe('Shop totals come from the server (T64)', () => {
  it('shows tax and the server-priced total instead of the local sum', async () => {
    const calls = mockApi({
      '/public/catalog': catalog(),
      'POST /public/quote': { subtotalCents: 3000, taxCents: 540, discountCents: 0, totalCents: 3540, inclusive: false },
    });
    renderShop();
    const add = await screen.findByRole('button', { name: 'Add T-Shirt to cart' });
    fireEvent.click(add);
    fireEvent.click(add);
    const cart = screen.getByRole('region', { name: 'Cart' });
    await waitFor(() => expect(within(cart).getByText('Total').parentElement).toHaveTextContent('$35.40'));
    expect(within(cart).getByText(/Tax \$5\.40/)).toBeInTheDocument();
    expect(within(cart).getByText(/Subtotal \$30\.00/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/public/quote').at(-1)!.body).toEqual({ items: [{ productId: 'p1', quantity: 2 }] });
  });

  it('says tax is included when prices include tax', async () => {
    mockApi({ '/public/catalog': catalog(), 'POST /public/quote': { subtotalCents: 1271, taxCents: 229, discountCents: 0, totalCents: 1500, inclusive: true } });
    renderShop();
    fireEvent.click(await screen.findByRole('button', { name: 'Add T-Shirt to cart' }));
    expect(await screen.findByText(/Includes tax \$2\.29/)).toBeInTheDocument();
  });

  it('falls back to the local sum when the quote is unavailable', async () => {
    mockApi({ '/public/catalog': catalog() }); // no quote route: 404
    renderShop();
    fireEvent.click(await screen.findByRole('button', { name: 'Add T-Shirt to cart' }));
    const cart = screen.getByRole('region', { name: 'Cart' });
    expect(within(cart).getByText('Total').parentElement).toHaveTextContent('$15.00');
    expect(within(cart).queryByText(/Tax/)).toBeNull();
  });
});

describe('Shop browsing & cart', () => {
  it('shows products, builds a cart capped at availability and a WhatsApp order link', async () => {
    mockApi({ '/public/catalog': catalog() });
    renderShop();
    expect(await screen.findByRole('heading', { name: 'Corner Shop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Mug to cart' })).toBeDisabled();
    const add = screen.getByRole('button', { name: 'Add T-Shirt to cart' });
    for (let i = 0; i < 5; i++) fireEvent.click(add);
    const cart = screen.getByRole('region', { name: 'Cart' });
    expect(within(cart).getByText('3 × T-Shirt')).toBeInTheDocument();
    expect(within(cart).getByText('Total').parentElement).toHaveTextContent('$45.00');
    const wa = within(cart).getByRole('link', { name: /order on whatsapp/i });
    expect(wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/15550001234\?text=/);
    expect(decodeURIComponent(wa.getAttribute('href')!.split('text=')[1]!)).toContain('order TEE 3');
  });

  it('filters by search text', async () => {
    mockApi({ '/public/catalog': catalog() });
    renderShop();
    await screen.findByText('T-Shirt');
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'mug' } });
    expect(screen.queryByText('T-Shirt')).not.toBeInTheDocument();
    expect(screen.getByText('Mug')).toBeInTheDocument();
  });
});

describe('Shop checkout with payment choice (T39)', () => {
  it('offers the enabled methods, pay online first; ONLINE sends to Razorpay and clears the cart only after success', async () => {
    const calls = mockApi({
      '/public/catalog': catalog(),
      'POST /public/orders': { number: 101, status: 'PENDING', totalCents: 1500, paymentMethod: 'ONLINE', token: 'tok-1', paymentUrl: 'https://rzp.io/i/abc' },
    });
    renderShop();
    await fillCheckout();
    expect(screen.getByLabelText(/pay online/i)).toBeChecked();
    expect(screen.getByLabelText(/cash on delivery/i)).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('https://rzp.io/i/abc'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/public/orders')!.body).toEqual({
      name: 'Mia', phone: '+15550007777', paymentMethod: 'ONLINE', items: [{ productId: 'p1', quantity: 1 }],
    });
    expect(JSON.parse(localStorage.getItem('stocksync.cart') ?? '{}')).toEqual({});
  });

  it('cash on delivery goes to the order status page', async () => {
    const calls = mockApi({
      '/public/catalog': catalog(),
      'POST /public/orders': { number: 102, status: 'PENDING', totalCents: 1500, paymentMethod: 'COD', token: 'tok-2' },
    });
    renderShop();
    await fillCheckout();
    fireEvent.click(screen.getByLabelText(/cash on delivery/i));
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('Order page for token')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/public/orders')!.body).toMatchObject({ paymentMethod: 'COD' });
    expect(redirectTo).not.toHaveBeenCalled();
  });

  it('keeps the cart and shows the error when the order is refused', async () => {
    mockApi({
      '/public/catalog': catalog(),
      'POST /public/orders': new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'Online payment is not available right now' } }), { status: 409 }),
    });
    renderShop();
    await fillCheckout();
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Online payment is not available right now');
    expect(redirectTo).not.toHaveBeenCalled();
    expect(within(screen.getByRole('region', { name: 'Cart' })).getByText('1 × T-Shirt')).toBeInTheDocument();
  });

  it('with a single method there is no choice; with none, ordering is disabled', async () => {
    mockApi({ '/public/catalog': catalog(['COD']) });
    const { unmount } = renderShop();
    await fillCheckout();
    expect(screen.queryByLabelText(/pay online/i)).not.toBeInTheDocument();
    expect(screen.getByText(/cash on delivery/i)).toBeInTheDocument();
    unmount();
    localStorage.clear();
    mockApi({ '/public/catalog': catalog([]) });
    renderShop();
    await fillCheckout();
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeDisabled();
  });

  it('never redirects to an unsafe payment URL; the shopper lands on the order page instead', async () => {
    mockApi({
      '/public/catalog': catalog(),
      'POST /public/orders': { number: 103, status: 'PENDING', totalCents: 1500, paymentMethod: 'ONLINE', token: 'tok-3', paymentUrl: 'javascript:alert(1)' },
    });
    renderShop();
    await fillCheckout();
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('Order page for token')).toBeInTheDocument();
    expect(redirectTo).not.toHaveBeenCalled();
  });
});

describe('resuming an unpaid online order (T53)', () => {
  const KEY = 'stocksync.lastOnlineOrder';
  const status = (over: object = {}) => ({ number: 9, status: 'PENDING', paymentMethod: 'ONLINE', paymentStatus: 'UNPAID', totalCents: 1500, currency: 'USD', items: [{ name: 'T-Shirt', quantity: 1 }], ...over });

  it('remembers an online order before sending the shopper to the payment page — but not a cash-on-delivery one', async () => {
    mockApi({
      '/public/catalog': catalog(),
      'POST /public/orders': { number: 9, status: 'PENDING', totalCents: 1500, paymentMethod: 'ONLINE', token: 'tok-9', paymentUrl: 'https://rzp.io/i/abc' },
    });
    const a = renderShop();
    await fillCheckout();
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(redirectTo).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ token: 'tok-9' });
    a.unmount();
    localStorage.clear();
    mockApi({
      '/public/catalog': catalog(),
      'POST /public/orders': { number: 10, status: 'PENDING', totalCents: 1500, paymentMethod: 'COD', token: 'tok-10' },
    });
    renderShop();
    await fillCheckout();
    fireEvent.click(screen.getByLabelText(/cash on delivery/i));
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByText('Order page for token');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('shows "Continue payment" while the remembered order is still unpaid', async () => {
    localStorage.setItem(KEY, JSON.stringify({ token: 'tok-9' }));
    mockApi({ '/public/catalog': catalog(), '/public/orders/tok-9': status() });
    renderShop();
    const link = await screen.findByRole('link', { name: /continue payment for order #9/i });
    expect(link).toHaveAttribute('href', '/shop/order/tok-9');
  });

  it.each([
    ['paid', { paymentStatus: 'PAID', status: 'CONFIRMED' }],
    ['cancelled', { status: 'CANCELLED' }],
  ])('forgets the order once it is %s', async (_name, over) => {
    localStorage.setItem(KEY, JSON.stringify({ token: 'tok-9' }));
    mockApi({ '/public/catalog': catalog(), '/public/orders/tok-9': status(over) });
    renderShop();
    await screen.findByRole('heading', { name: 'Corner Shop' });
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
    expect(screen.queryByRole('link', { name: /continue payment/i })).not.toBeInTheDocument();
  });

  it('forgets an order the server no longer knows, but keeps it through a temporary server error', async () => {
    localStorage.setItem(KEY, JSON.stringify({ token: 'tok-9' }));
    mockApi({ '/public/catalog': catalog(), '/public/orders/tok-9': new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Order not found' } }), { status: 404 }) });
    const a = renderShop();
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
    a.unmount();
    localStorage.setItem(KEY, JSON.stringify({ token: 'tok-9' }));
    mockApi({ '/public/catalog': catalog(), '/public/orders/tok-9': new Response('{}', { status: 500 }) });
    renderShop();
    await screen.findByRole('heading', { name: 'Corner Shop' });
    expect(localStorage.getItem(KEY)).not.toBeNull();
    expect(screen.queryByRole('link', { name: /continue payment/i })).not.toBeInTheDocument();
  });

  it('ignores corrupt stored data', async () => {
    localStorage.setItem(KEY, '{not json');
    mockApi({ '/public/catalog': catalog() });
    renderShop();
    expect(await screen.findByRole('heading', { name: 'Corner Shop' })).toBeInTheDocument();
  });
});
