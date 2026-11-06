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
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
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
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ paymentMethod: 'COD' });
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
