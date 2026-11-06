import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ShopOrder } from './ShopOrder';
import { mockApi } from '../test/setup';

const redirectTo = vi.fn();
vi.mock('../redirect', async (orig) => ({ ...(await orig<typeof import('../redirect')>()), redirectTo: (url: string) => redirectTo(url) }));

const base = { number: 7, status: 'PENDING', paymentMethod: 'ONLINE', paymentStatus: 'UNPAID', totalCents: 3000, currency: 'INR', items: [{ name: 'T-Shirt', quantity: 2 }] };

function renderOrder(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/shop/order/tok-1${search}`]}>
      <Routes><Route path="/shop/order/:token" element={<ShopOrder />} /></Routes>
    </MemoryRouter>,
  );
}
const orderCalls = (calls: { path: string }[]) => calls.filter((c) => c.path === '/public/orders/tok-1').length;

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); redirectTo.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe('ShopOrder status page (T39)', () => {
  it('cash on delivery: shows the order, items, total and that payment is due on delivery — no polling', async () => {
    const calls = mockApi({ '/public/orders/tok-1': { ...base, paymentMethod: 'COD' } });
    renderOrder();
    expect(await screen.findByRole('heading', { name: 'Order #7' })).toBeInTheDocument();
    expect(screen.getByText(/pay cash on delivery/i)).toBeInTheDocument();
    expect(screen.getByText('2 × T-Shirt')).toBeInTheDocument();
    expect(screen.getByText('₹30.00')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(orderCalls(calls)).toBe(1);
  });

  it('online & unpaid: shows a Pay button, polls, and updates to "payment received" then stops polling', async () => {
    let n = 0;
    const calls = mockApi({
      '/public/orders/tok-1': () => (++n < 3
        ? { ...base, paymentUrl: 'https://rzp.io/i/abc' }
        : { ...base, status: 'CONFIRMED', paymentStatus: 'PAID' }),
    });
    renderOrder();
    expect(await screen.findByText(/waiting for payment/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /pay ₹30\.00/i })).toHaveAttribute('href', 'https://rzp.io/i/abc');
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await screen.findByText(/payment received — your order is confirmed/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pay ₹/i })).not.toBeInTheDocument();
    const settled = orderCalls(calls);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(orderCalls(calls)).toBe(settled);
  });

  it('gives up polling after two minutes and says what to do', async () => {
    const calls = mockApi({ '/public/orders/tok-1': { ...base, paymentUrl: 'https://rzp.io/i/abc' } });
    renderOrder();
    await screen.findByText(/waiting for payment/i);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(await screen.findByText(/still waiting for the payment confirmation/i)).toBeInTheDocument();
    const stopped = orderCalls(calls);
    expect(stopped).toBeLessThanOrEqual(42);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(orderCalls(calls)).toBe(stopped);
    expect(screen.getByRole('link', { name: /pay ₹30\.00/i })).toBeInTheDocument();
  });

  it('the Razorpay redirect query only changes the wording — state always comes from the server', async () => {
    mockApi({ '/public/orders/tok-1': { ...base, paymentUrl: 'https://rzp.io/i/abc' } });
    renderOrder('?razorpay_payment_link_status=paid&razorpay_payment_id=pay_1&razorpay_signature=zzz');
    expect(await screen.findByText(/confirming your payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/payment received/i)).not.toBeInTheDocument();
  });

  it('explains paid-but-pending, refund due, and cancelled orders', async () => {
    mockApi({ '/public/orders/tok-1': { ...base, paymentStatus: 'PAID' } });
    const a = renderOrder();
    expect(await screen.findByText(/payment received\. we'll confirm your order shortly/i)).toBeInTheDocument();
    a.unmount();
    mockApi({ '/public/orders/tok-1': { ...base, paymentStatus: 'REFUND_DUE' } });
    const b = renderOrder();
    expect(await screen.findByText(/refund is on its way/i)).toBeInTheDocument();
    b.unmount();
    mockApi({ '/public/orders/tok-1': { ...base, status: 'CANCELLED' } });
    renderOrder();
    expect(await screen.findByText(/this order was cancelled/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pay ₹/i })).not.toBeInTheDocument();
  });

  it('does not render an unsafe pay link, and handles unknown orders', async () => {
    mockApi({ '/public/orders/tok-1': { ...base, paymentUrl: 'javascript:alert(1)' } });
    const a = renderOrder();
    await screen.findByText(/waiting for payment/i);
    expect(screen.queryByRole('link', { name: /pay ₹/i })).not.toBeInTheDocument();
    a.unmount();
    mockApi({ '/public/orders/tok-1': new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Order not found' } }), { status: 404 }) });
    renderOrder();
    expect(await screen.findByText(/couldn't find that order/i)).toBeInTheDocument();
  });
});

describe('resuming payment (T52)', () => {
  const renewRoute = 'POST /public/orders/tok-1/payment-link';

  it('an expired link (no paymentUrl) offers a new one; clicking fetches it and goes to the payment page', async () => {
    const calls = mockApi({ '/public/orders/tok-1': base, [renewRoute]: { paymentUrl: 'https://rzp.io/i/fresh' } }); // no paymentUrl → expired
    renderOrder();
    const button = await screen.findByRole('button', { name: /get a new payment link/i });
    fireEvent.click(button);
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('https://rzp.io/i/fresh'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/public/orders/tok-1/payment-link')).toBe(true);
  });

  it('shows the error and does not redirect when a new link cannot be created', async () => {
    mockApi({
      '/public/orders/tok-1': base,
      [renewRoute]: new Response(JSON.stringify({ error: { code: 'PAYMENT_PROVIDER_ERROR', message: 'Could not create the payment link right now — please try again in a moment.' } }), { status: 502 }),
    });
    renderOrder();
    fireEvent.click(await screen.findByRole('button', { name: /get a new payment link/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not create the payment link/i);
    expect(redirectTo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /get a new payment link/i })).toBeEnabled(); // can try again
  });

  it('never follows an unsafe URL returned by the API', async () => {
    mockApi({ '/public/orders/tok-1': base, [renewRoute]: { paymentUrl: 'javascript:alert(1)' } });
    renderOrder();
    fireEvent.click(await screen.findByRole('button', { name: /get a new payment link/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(redirectTo).not.toHaveBeenCalled();
  });

  it('with a valid link there is the direct Pay link and no "new link" button; paid and COD orders have neither', async () => {
    mockApi({ '/public/orders/tok-1': { ...base, paymentUrl: 'https://rzp.io/i/abc' } });
    const a = renderOrder();
    await screen.findByRole('link', { name: /pay ₹30\.00/i });
    expect(screen.queryByRole('button', { name: /new payment link/i })).not.toBeInTheDocument();
    a.unmount();
    mockApi({ '/public/orders/tok-1': { ...base, paymentStatus: 'PAID', status: 'CONFIRMED' } });
    const b = renderOrder();
    await screen.findByText(/payment received/i);
    expect(screen.queryByRole('button', { name: /new payment link/i })).not.toBeInTheDocument();
    b.unmount();
    mockApi({ '/public/orders/tok-1': { ...base, paymentMethod: 'COD' } });
    renderOrder();
    await screen.findByText(/pay cash on delivery/i);
    expect(screen.queryByRole('button', { name: /new payment link/i })).not.toBeInTheDocument();
  });
});
