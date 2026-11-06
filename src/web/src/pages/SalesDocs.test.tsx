import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Orders } from './Orders';
import { setToken } from '../api/client';
import { mockApi } from '../test/setup';

vi.mock('../api/events', () => ({ subscribeEvents: () => () => {} }));
vi.mock('../auth', () => ({ useAuth: () => ({ can: () => true, user: { id: 'u', role: 'admin' } }) }));

const item = (over: object = {}) => ({ id: 'i1', productId: 'p1', sku: 'TEE', name: 'T-Shirt', quantity: 3, unitPriceCents: 1500, taxRateBp: 1800, discountCents: 0, ...over });
const order = (over: object = {}) => ({
  id: 'o1', number: 1, customerId: 'c1', customerName: 'Asha', channel: 'web', status: 'PENDING', warehouseId: null,
  totalCents: 5310, subtotalCents: 4500, taxCents: 810, discountCents: 0, notes: '', createdAt: '2026-11-06T10:00:00Z', updatedAt: '2026-11-06T10:00:00Z',
  paymentMethod: 'COD', paymentStatus: 'UNPAID', publicToken: 't', items: [item(), item({ id: 'i2', productId: 'p2', sku: 'MUG', name: 'Mug', quantity: 1, unitPriceCents: 800, taxRateBp: 0 })], ...over,
});
const base = (orders: object[], extra: Record<string, unknown> = {}) => ({
  '/orders': orders,
  '/warehouses': [{ id: 'w1', code: 'MAIN', name: 'Main', address: '' }, { id: 'w2', code: 'SHOP', name: 'Shop', address: '' }],
  '/customers': [{ id: 'c1', name: 'Asha', phone: '+91 98' }],
  '/products': [{ id: 'p1', sku: 'TEE', name: 'T-Shirt', isActive: true, totalQuantity: 9 }],
  '/payments/config': { razorpayConfigured: false, onlineAvailable: false, codEnabled: true },
  '/settings': { currency: 'USD' },
  ...extra,
});
const view = () => render(<MemoryRouter><Orders /></MemoryRouter>);
const rowOf = async (n: number) => (await screen.findByText(`#${n}`)).closest('tr')!;

const open = vi.fn();
beforeEach(() => {
  open.mockReset().mockReturnValue({});
  vi.stubGlobal('open', open);
  URL.createObjectURL = vi.fn(() => 'blob:doc');
  URL.revokeObjectURL = vi.fn();
  setToken('tok-123');
});

describe('Orders: tax and discount (T69)', () => {
  it('shows the tax and discount that make up the total', async () => {
    mockApi(base([order({ taxCents: 540, discountCents: 100, totalCents: 3540 })]));
    view();
    const row = await rowOf(1);
    expect(within(row).getByText(/Tax \$5\.40/)).toBeInTheDocument();
    expect(within(row).getByText(/Discount \$1\.00/)).toBeInTheDocument();
  });

  it('shows neither when there is none', async () => {
    mockApi(base([order({ taxCents: 0, discountCents: 0 })]));
    view();
    const row = await rowOf(1);
    expect(within(row).queryByText(/Tax \$/)).toBeNull();
    expect(within(row).queryByText(/Discount \$/)).toBeNull();
  });
});

describe('New order: discount entry (T69)', () => {
  const fill = async () => {
    fireEvent.click(await screen.findByRole('button', { name: '+ New order' }));
    await screen.findByRole('option', { name: /Asha/ });
    await screen.findByRole('option', { name: /TEE/ });
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Item 1'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '2' } });
  };

  it('sends a percentage line discount and a fixed order discount in minor units', async () => {
    const calls = mockApi({ ...base([]), 'POST /orders': order() });
    view();
    await fill();
    fireEvent.change(screen.getByLabelText('Discount 1'), { target: { value: '10%' } });
    fireEvent.change(screen.getByLabelText('Order discount'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      customerId: 'c1', items: [{ productId: 'p1', quantity: 2, discount: { type: 'percent', basisPoints: 1000 } }], discount: { type: 'fixed', cents: 100 },
    });
  });

  it('sends no discount keys when none are entered', async () => {
    const calls = mockApi({ ...base([]), 'POST /orders': order() });
    view();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ customerId: 'c1', items: [{ productId: 'p1', quantity: 2 }] });
  });

  it.each([['abc'], ['150%'], ['-5'], ['1.234']])('refuses the invalid discount %s without calling the API', async (bad) => {
    const calls = mockApi(base([]));
    view();
    await fill();
    fireEvent.change(screen.getByLabelText('Order discount'), { target: { value: bad } });
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/discount/i);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('Printing documents (T69)', () => {
  it('opens the invoice of an order, fetched with the session token', async () => {
    const calls = mockApi(base([order({ id: 'o2', number: 2, status: 'CONFIRMED' })], {
      '/invoices?orderId=o2': [{ id: 'inv1', number: 'INV-2026-000001' }],
      '/invoices/inv1/print': new Response('<!doctype html><p>INV</p>', { headers: { 'content-type': 'text/html' } }),
    }));
    view();
    fireEvent.click(within(await rowOf(2)).getByRole('button', { name: 'Invoice' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:doc', '_blank'));
    expect(calls.find((c) => c.path === '/invoices/inv1/print')!.headers.authorization).toBe('Bearer tok-123');
  });

  it('says so when an order has no invoice yet', async () => {
    mockApi(base([order({ id: 'o2', number: 2, status: 'CONFIRMED' })], { '/invoices?orderId=o2': [] }));
    view();
    fireEvent.click(within(await rowOf(2)).getByRole('button', { name: 'Invoice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no invoice/i);
    expect(open).not.toHaveBeenCalled();
  });

  it('explains a blocked pop-up', async () => {
    open.mockReturnValue(null);
    mockApi(base([order({ id: 'o2', number: 2, status: 'CONFIRMED' })], { '/orders/o2/packing-slip': new Response('<p>slip</p>') }));
    view();
    fireEvent.click(within(await rowOf(2)).getByRole('button', { name: 'Packing slip' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/pop-ups/i);
  });

  it('prints one pick list for the selected open orders', async () => {
    const calls = mockApi(base([order({ id: 'o1', number: 1 }), order({ id: 'o3', number: 3, status: 'CONFIRMED' }), order({ id: 'o4', number: 4, status: 'CANCELLED' })], {
      '/picklists?orderIds=o1,o3': new Response('<p>pick</p>'),
    }));
    view();
    await rowOf(1);
    const print = screen.getByRole('button', { name: 'Print pick list' });
    expect(print).toBeDisabled();
    expect(screen.queryByLabelText('Select order #4')).toBeNull(); // cancelled orders cannot be picked
    fireEvent.click(screen.getByLabelText('Select order #1'));
    fireEvent.click(screen.getByLabelText('Select order #3'));
    expect(print).toBeEnabled();
    fireEvent.click(print);
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(calls.some((c) => c.path === '/picklists?orderIds=o1,o3')).toBe(true);
  });
});

describe('Returning goods (T69)', () => {
  const confirmed = order({ id: 'o2', number: 2, status: 'CONFIRMED', warehouseId: 'w1' });
  const earlier = [{ id: 'r0', items: [{ orderItemId: 'i1', quantity: 1 }] }];

  it('shows how many of each line can still be returned and refuses more', async () => {
    const calls = mockApi({ ...base([confirmed]), '/returns?orderId=o2': earlier });
    view();
    fireEvent.click(within(await rowOf(2)).getByRole('button', { name: 'Return' }));
    expect(await screen.findByText(/2 can still be returned/)).toBeInTheDocument(); // 3 bought, 1 already back
    expect(screen.getByText(/1 can still be returned/)).toBeInTheDocument();       // the mug
    fireEvent.change(screen.getByLabelText('Return TEE'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record return' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/only 2 can still be returned for TEE/i);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('sends the chosen quantities, reuses the request id on retry, and reports the credit note and refund', async () => {
    let attempt = 0;
    const calls = mockApi({
      ...base([confirmed]), '/returns?orderId=o2': earlier,
      'POST /orders/o2/returns': () => (++attempt === 1
        ? new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal server error' } }), { status: 500 })
        : { id: 'r1', number: 5, refundStatus: 'REFUND_DUE', refundCents: 1770, creditTotalCents: 1770, creditNote: { id: 'cn1', number: 'CN-2026-000001' } }),
    });
    view();
    fireEvent.click(within(await rowOf(2)).getByRole('button', { name: 'Return' }));
    await screen.findByRole('option', { name: 'MAIN' });
    fireEvent.change(await screen.findByLabelText('Return TEE'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Wrong size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record return' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error');
    fireEvent.click(screen.getByRole('button', { name: 'Record return' }));
    expect(await screen.findByText(/CN-2026-000001/)).toBeInTheDocument();
    expect(screen.getByText(/refund \$17\.70/i)).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual({ requestId: expect.any(String), warehouseId: 'w1', lines: [{ orderItemId: 'i1', quantity: 2 }], reason: 'Wrong size' });
    expect((posts[1]!.body as { requestId: string }).requestId).toBe((posts[0]!.body as { requestId: string }).requestId);
  });

  it('needs at least one quantity, and only confirmed or fulfilled orders offer a return', async () => {
    const calls = mockApi({ ...base([confirmed, order({ id: 'o9', number: 9 }), order({ id: 'o8', number: 8, status: 'CANCELLED' })]), '/returns?orderId=o2': [] });
    view();
    expect(within(await rowOf(9)).queryByRole('button', { name: 'Return' })).toBeNull();
    expect(within(await rowOf(8)).queryByRole('button', { name: 'Return' })).toBeNull();
    fireEvent.click(within(await rowOf(2)).getByRole('button', { name: 'Return' }));
    await screen.findByLabelText('Return TEE');
    fireEvent.click(screen.getByRole('button', { name: 'Record return' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/quantity to return/i);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
