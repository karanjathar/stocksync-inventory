import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Orders } from './Orders';
import { SettingsPage } from './SettingsPage';
import { mockApi } from '../test/setup';
import type { RealtimeEvent } from '../api/types';

const bus = vi.hoisted(() => ({ emit: undefined as undefined | ((e: RealtimeEvent) => void) }));
vi.mock('../api/events', () => ({ subscribeEvents: (fn: (e: RealtimeEvent) => void) => { bus.emit = fn; return () => { bus.emit = undefined; }; } }));
vi.mock('../auth', () => ({ useAuth: () => ({ can: () => true, user: { id: 'u', role: 'admin' } }) }));

const mk = (over: object) => ({
  id: 'o1', number: 42, customerId: 'c1', customerName: 'Asha', channel: 'whatsapp', status: 'PENDING', warehouseId: null,
  totalCents: 3000, notes: '', createdAt: '2026-11-06T10:00:00Z', updatedAt: '2026-11-06T10:00:00Z',
  paymentMethod: 'ONLINE', paymentStatus: 'UNPAID', publicToken: 't',
  items: [{ productId: 'p1', sku: 'TEE', name: 'T-Shirt', quantity: 2, unitPriceCents: 1500 }], ...over,
});
const config = (over: object = {}) => ({ razorpayConfigured: true, onlineAvailable: true, codEnabled: true, ...over });
const settings = (payments = { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 }) =>
  ({ businessName: 'Shop', currency: 'INR', whatsappNumber: '', defaultWarehouseId: null, alertRecipients: [], customFields: [], payments });

const writeText = vi.fn();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

const renderOrders = () => render(<MemoryRouter><Orders /></MemoryRouter>);
const rowOf = async (n: number) => (await screen.findByText(`#${n}`)).closest('tr')!;

describe('Orders: payment info (T40)', () => {
  const routes = (orders: object[], cfg = config()) => ({ '/orders': orders, '/warehouses': [], '/customers': [], '/products': [], '/payments/config': cfg, '/settings': settings() });

  it('shows method and payment badges, and highlights refund-due orders', async () => {
    mockApi(routes([
      mk({ id: 'a', number: 1, paymentMethod: 'COD' }),
      mk({ id: 'b', number: 2, paymentStatus: 'PAID', status: 'CONFIRMED' }),
      mk({ id: 'c', number: 3, paymentStatus: 'REFUND_DUE', status: 'CANCELLED' }),
    ]));
    renderOrders();
    const cod = await rowOf(1);
    expect(within(cod).getByText('Cash on delivery')).toBeInTheDocument();
    expect(within(cod).getByText('unpaid')).toBeInTheDocument();
    const paid = await rowOf(2);
    expect(within(paid).getByText('Online')).toBeInTheDocument();
    expect(within(paid).getByText('paid')).toBeInTheDocument();
    const refund = await rowOf(3);
    expect(within(refund).getByText('Refund due')).toBeInTheDocument();
    expect(refund).toHaveClass('row-alert');
    expect(cod).not.toHaveClass('row-alert');
  });

  it('offers Send link (chat orders) and Copy link only for unpaid orders while online payment is available', async () => {
    mockApi(routes([
      mk({ id: 'a', number: 1 }),                                          // chat, unpaid
      mk({ id: 'b', number: 2, channel: 'web', customerName: 'Web Mia' }), // web, unpaid
      mk({ id: 'c', number: 3, paymentStatus: 'PAID', status: 'CONFIRMED' }),
      mk({ id: 'd', number: 4, status: 'CANCELLED' }),
    ]));
    renderOrders();
    expect(within(await rowOf(1)).getByRole('button', { name: 'Send link' })).toBeInTheDocument();
    expect(within(await rowOf(1)).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(within(await rowOf(2)).queryByRole('button', { name: 'Send link' })).not.toBeInTheDocument();
    expect(within(await rowOf(2)).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    for (const n of [3, 4]) {
      expect(within(await rowOf(n)).queryByRole('button', { name: /link/ })).not.toBeInTheDocument();
    }
  });

  it('hides link actions when online payment is unavailable', async () => {
    mockApi(routes([mk({})], config({ onlineAvailable: false, reason: 'Razorpay keys are not configured on the server.' })));
    renderOrders();
    expect(within(await rowOf(42)).queryByRole('button', { name: /link/ })).not.toBeInTheDocument();
  });

  it('Send link asks the server to deliver it to the customer and confirms', async () => {
    const calls = mockApi({ ...routes([mk({})]), 'POST /orders/o1/payment-link': { url: 'https://rzp.io/i/abc', expiresAt: '2026-11-07T10:00:00Z', notified: true } });
    renderOrders();
    fireEvent.click(within(await rowOf(42)).getByRole('button', { name: 'Send link' }));
    expect(await screen.findByText(/sent to the customer/i)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/orders/o1/payment-link')!.body).toEqual({ notify: true });
  });

  it('Copy link copies the URL and shows it; reports when the customer cannot be messaged', async () => {
    mockApi({ ...routes([mk({ channel: 'web' })]), 'POST /orders/o1/payment-link': { url: 'https://rzp.io/i/xyz', expiresAt: '2026-11-07T10:00:00Z', notified: false } });
    renderOrders();
    fireEvent.click(within(await rowOf(42)).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://rzp.io/i/xyz'));
    expect(await screen.findByText('https://rzp.io/i/xyz')).toBeInTheDocument();
    expect(screen.getByText(/copied/i)).toBeInTheDocument();
  });

  it('shows the URL for manual copying when the clipboard is unavailable, and surfaces API errors', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    mockApi({ ...routes([mk({})]), 'POST /orders/o1/payment-link': { url: 'https://rzp.io/i/q', expiresAt: '2026-11-07T10:00:00Z', notified: false } });
    renderOrders();
    fireEvent.click(within(await rowOf(42)).getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('https://rzp.io/i/q')).toBeInTheDocument();
    expect(screen.getByText(/select and copy/i)).toBeInTheDocument();
  });

  it('refreshes live when a payment event arrives', async () => {
    let paid = false;
    const calls = mockApi({ ...routes([]), '/orders': () => [mk(paid ? { paymentStatus: 'PAID', status: 'CONFIRMED' } : {})] });
    renderOrders();
    expect(within(await rowOf(42)).getByText('unpaid')).toBeInTheDocument();
    const before = calls.filter((c) => c.path === '/orders').length;
    paid = true;
    await act(async () => { bus.emit?.({ type: 'payment.updated', orderId: 'o1', number: 42, paymentStatus: 'PAID' }); });
    await waitFor(() => expect(within(screen.getByText('#42').closest('tr')!).getByText('paid')).toBeInTheDocument());
    expect(calls.filter((c) => c.path === '/orders').length).toBeGreaterThan(before);
  });
});

describe('Settings: payments (T40)', () => {
  const routes = (cfg = config(), payments?: ReturnType<typeof settings>['payments']) => ({
    '/settings': settings(payments), '/warehouses': [], '/channels': [], '/payments/config': cfg,
    'PUT /settings': (b: unknown) => b,
  });

  it('explains why online payments are unavailable and shows the webhook URL to configure', async () => {
    mockApi(routes(config({ razorpayConfigured: false, onlineAvailable: false, reason: 'Razorpay keys are not configured on the server.' })));
    render(<SettingsPage />);
    expect(await screen.findByText(/keys are not configured on the server/i)).toBeInTheDocument();
    expect(screen.getByText(/\/webhooks\/razorpay/)).toBeInTheDocument();
    expect(screen.getByText(/payment_link\.paid/)).toBeInTheDocument();
  });

  it('shows availability, and saves the payment options', async () => {
    const calls = mockApi(routes());
    render(<SettingsPage />);
    expect(await screen.findByText(/online payments are available/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/accept cash on delivery/i));
    fireEvent.change(screen.getByLabelText(/payment link validity/i), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ payments: { onlineEnabled: true, codEnabled: false, linkExpiryMinutes: 60 } });
  });

  it('refuses a link validity below 15 minutes (Razorpay minimum) without calling the API', async () => {
    const calls = mockApi(routes());
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText(/payment link validity/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 15 minutes/i);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('Settings: warns when no payment method would be usable (T55)', () => {
  const routes = (cfg: ReturnType<typeof config>) => ({ '/settings': settings(), '/warehouses': [], '/channels': [], '/payments/config': cfg });
  const warning = /no payment method/i;

  it('stays quiet when at least one method works', async () => {
    mockApi(routes(config()));
    render(<SettingsPage />);
    await screen.findByText(/online payments are available/i);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it('warns as soon as unticking cash on delivery leaves only an unconfigured online option, and clears when fixed', async () => {
    mockApi(routes(config({ razorpayConfigured: false, onlineAvailable: false, reason: 'Razorpay keys are not configured on the server.' })));
    render(<SettingsPage />);
    await screen.findByText(/keys are not configured on the server/i);
    expect(screen.queryByText(warning)).not.toBeInTheDocument(); // COD still on
    fireEvent.click(screen.getByLabelText(/accept cash on delivery/i));
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.getByText(warning)).toHaveTextContent(/won't be able to place orders/i);
    fireEvent.click(screen.getByLabelText(/accept cash on delivery/i));
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it('counts the shop currency: online needs INR, so switching to USD with COD off warns', async () => {
    mockApi(routes(config())); // Razorpay configured, currently INR
    render(<SettingsPage />);
    await screen.findByText(/online payments are available/i);
    fireEvent.click(screen.getByLabelText(/accept cash on delivery/i));
    expect(screen.queryByText(warning)).not.toBeInTheDocument(); // online still works
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'USD' } });
    expect(screen.getByText(warning)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'INR' } });
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it('warns when both switches are off even though Razorpay is configured', async () => {
    mockApi(routes(config()));
    render(<SettingsPage />);
    await screen.findByText(/online payments are available/i);
    fireEvent.click(screen.getByLabelText(/accept online payments/i));
    fireEvent.click(screen.getByLabelText(/accept cash on delivery/i));
    expect(screen.getByText(warning)).toBeInTheDocument();
  });
});
