import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PurchaseOrders } from './PurchaseOrders';
import { mockApi } from '../test/setup';

const auth = vi.hoisted(() => ({ role: 'staff' as 'staff' | 'viewer' }));
vi.mock('../auth', () => ({ useAuth: () => ({ can: (r: string) => r === 'viewer' || auth.role === 'staff', user: { id: 'u', role: auth.role } }) }));

const item = (over: object = {}) => ({ id: 'i1', productId: 'p1', sku: 'TEE', name: 'T-Shirt', quantity: 10, receivedQuantity: 0, unitCostCents: 900, ...over });
const po = (over: object = {}) => ({
  id: 'po1', number: 7, supplierId: 's1', supplierName: 'Acme', status: 'DRAFT', warehouseId: 'w1', expectedDate: null, notes: '',
  totalCents: 9000, items: [item()], createdBy: null, createdAt: '2026-11-06T10:00:00Z', updatedAt: '2026-11-06T10:00:00Z', ...over,
});
const base = (orders: object[]) => ({
  '/purchase-orders': orders,
  '/suppliers': [{ id: 's1', name: 'Acme' }, { id: 's2', name: 'Globex' }],
  '/warehouses': [{ id: 'w1', code: 'MAIN', name: 'Main', address: '' }, { id: 'w2', code: 'SHOP', name: 'Shop', address: '' }],
  '/products': [{ id: 'p1', sku: 'TEE', name: 'T-Shirt', isActive: true, totalQuantity: 3 }, { id: 'p2', sku: 'MUG', name: 'Mug', isActive: true, totalQuantity: 0 }],
  '/settings': { currency: 'INR' },
});
const view = () => render(<MemoryRouter><PurchaseOrders /></MemoryRouter>);

describe('Purchase orders screen (T63)', () => {
  it('lists orders with supplier, status and total', async () => {
    auth.role = 'staff';
    mockApi(base([po(), po({ id: 'po2', number: 8, status: 'SENT', supplierName: 'Globex' })]));
    view();
    const row = (await screen.findByText('#7')).closest('tr')!;
    expect(within(row).getByText('Acme')).toBeInTheDocument();
    expect(within(row).getByText('DRAFT')).toBeInTheDocument();
    expect(within(row).getByText(/90\.00/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(within((await screen.findByText('#8')).closest('tr')!).getByRole('button', { name: 'Receive' })).toBeInTheDocument();
  });

  it('viewers can read but see no action buttons', async () => {
    auth.role = 'viewer';
    mockApi(base([po(), po({ id: 'po2', number: 8, status: 'SENT' })]));
    view();
    await screen.findByText('#7');
    expect(screen.queryByRole('button', { name: /new purchase order/i })).toBeNull();
    for (const name of ['Send', 'Receive', 'Edit', 'Cancel']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('sends a draft order', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...base([po()]), 'POST /purchase-orders/po1/send': po({ status: 'SENT' }) });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/purchase-orders/po1/send')).toBe(true));
  });

  it('creates an order, converting the unit cost to minor units', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...base([]), 'POST /purchase-orders': po() });
    view();
    fireEvent.click(await screen.findByRole('button', { name: '+ New purchase order' }));
    await screen.findByRole('option', { name: 'Acme' });
    await screen.findByRole('option', { name: 'MAIN' });
    await screen.findByRole('option', { name: /TEE/ });
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('Deliver to'), { target: { value: 'w1' } });
    fireEvent.change(screen.getByLabelText('Item 1'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Qty 1'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Unit cost 1'), { target: { value: '9.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create purchase order' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/purchase-orders')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ supplierId: 's1', warehouseId: 'w1', items: [{ productId: 'p1', quantity: 10, unitCostCents: 900 }] });
  });

  it('rejects an invalid unit cost without calling the API', async () => {
    auth.role = 'staff';
    const calls = mockApi(base([]));
    view();
    fireEvent.click(await screen.findByRole('button', { name: '+ New purchase order' }));
    await screen.findByRole('option', { name: 'Acme' });
    await screen.findByRole('option', { name: 'MAIN' });
    await screen.findByRole('option', { name: /TEE/ });
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('Deliver to'), { target: { value: 'w1' } });
    fireEvent.change(screen.getByLabelText('Item 1'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Unit cost 1'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create purchase order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unit cost/i);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('edits a draft with PATCH', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...base([po()]), 'PATCH /purchase-orders/po1': po() });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Qty 1'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ items: [{ productId: 'p1', quantity: 12, unitCostCents: 900 }] });
  });

  it('receives partial quantities and refuses more than is still expected', async () => {
    auth.role = 'staff';
    const sent = po({ id: 'po2', number: 9, status: 'PARTIALLY_RECEIVED', items: [item({ receivedQuantity: 2 }), item({ id: 'i2', productId: 'p2', sku: 'MUG', name: 'Mug', quantity: 4 })] });
    const calls = mockApi({ ...base([sent]), 'POST /purchase-orders/po2/receive': sent });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Receive' }));
    expect(await screen.findByText(/8 still expected/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Receive TEE'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book receipt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/only 8/i);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.change(screen.getByLabelText('Receive TEE'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book receipt' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/purchase-orders/po2/receive')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ lines: [{ itemId: 'i1', quantity: 3 }] }); // MUG left blank is not sent
  });

  it('can fill every remaining quantity and send the chosen warehouse', async () => {
    auth.role = 'staff';
    const sent = po({ status: 'SENT', items: [item(), item({ id: 'i2', productId: 'p2', sku: 'MUG', name: 'Mug', quantity: 4 })] });
    const calls = mockApi({ ...base([sent]), 'POST /purchase-orders/po1/receive': sent });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Receive' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fill remaining' }));
    await screen.findByRole('option', { name: 'SHOP' });
    fireEvent.change(screen.getByLabelText('Receive into'), { target: { value: 'w2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book receipt' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ lines: [{ itemId: 'i1', quantity: 10, warehouseId: 'w2' }, { itemId: 'i2', quantity: 4, warehouseId: 'w2' }] });
  });

  it('shows server errors', async () => {
    auth.role = 'staff';
    mockApi({ ...base([po({ status: 'SENT' })]), 'POST /purchase-orders/po1/cancel': new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'This purchase order cannot be cancelled (it is RECEIVED)' } }), { status: 409 }) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be cancelled');
  });
});
