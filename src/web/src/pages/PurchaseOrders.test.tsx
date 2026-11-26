import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PurchaseOrders } from './PurchaseOrders';
import { mockApi } from '../test/setup';

const auth = vi.hoisted(() => ({ role: 'staff' as 'staff' | 'viewer' }));
vi.mock('../auth', () => ({ useAuth: () => ({ can: (r: string) => r === 'viewer' || auth.role === 'staff', user: { id: 'u', role: auth.role } }) }));

const line = (sku: string, quantity: number, receivedQuantity: number, unitCostCents: number) => ({ productId: `p-${sku}`, sku, name: sku, quantity, receivedQuantity, unitCostCents });
const po = (id: string, number: number, status: string, lines: ReturnType<typeof line>[]) => ({ id, number, supplierId: 's1', supplierName: 'Acme', warehouseId: 'w1', status, notes: '', lines,
  totalCents: lines.reduce((t, l) => t + l.quantity * l.unitCostCents, 0), createdAt: '2026-11-26T10:00:00Z', updatedAt: '2026-11-26T10:00:00Z' });
const routes = () => ({
  '/purchase-orders': [po('po1', 1, 'DRAFT', [line('TEE', 10, 0, 900)]), po('po2', 2, 'PARTIALLY_RECEIVED', [line('TEE', 10, 4, 900), line('MUG', 4, 0, 300)])],
  '/suppliers': [{ id: 's1', name: 'Acme' }], '/warehouses': [{ id: 'w1', code: 'MAIN', name: 'Main', address: '' }],
  '/products': [{ id: 'p-TEE', sku: 'TEE', name: 'T-Shirt', priceCents: 1500 }, { id: 'p-MUG', sku: 'MUG', name: 'Mug', priceCents: 800 }],
});
const renderPage = () => render(<MemoryRouter><PurchaseOrders /></MemoryRouter>);

describe('Purchase orders', () => {
  it('lists orders with supplier, status and total', async () => {
    auth.role = 'staff';
    mockApi(routes());
    renderPage();
    const row = (await screen.findByText('#1')).closest('tr')!;
    expect(within(row).getByText('Acme')).toBeInTheDocument();
    expect(within(row).getByText('DRAFT')).toBeInTheDocument();
    expect(within(row).getByText('$90.00')).toBeInTheDocument();
    expect(screen.getByText('PARTIALLY_RECEIVED')).toBeInTheDocument();
  });

  it('creates a draft from supplier, warehouse and lines', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...routes(), 'POST /purchase-orders': (b: unknown) => b });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New purchase order' }));
    fireEvent.change(await screen.findByLabelText('Supplier'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('Warehouse'), { target: { value: 'w1' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add line' }));
    fireEvent.change(screen.getByLabelText('Line 1 product'), { target: { value: 'p-TEE' } });
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Line 1 unit cost'), { target: { value: '9.50' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Rush' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/purchase-orders')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ supplierId: 's1', warehouseId: 'w1', notes: 'Rush', lines: [{ productId: 'p-TEE', quantity: 12, unitCostCents: 950 }] });
  });

  it('sends a draft', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...routes(), 'POST /purchase-orders/po1/send': {} });
    renderPage();
    const row = (await screen.findByText('#1')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/purchase-orders/po1/send')).toBe(true));
  });

  it('receives part of an order with a unique receipt id and only the quantities entered', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...routes(), 'POST /purchase-orders/po2/receive': {} });
    renderPage();
    const row = (await screen.findByText('#2')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Receive' }));
    expect(await screen.findByLabelText('Receive TEE')).toHaveValue(6);   // 10 ordered − 4 received
    expect(screen.getByLabelText('Receive MUG')).toHaveValue(4);
    fireEvent.change(screen.getByLabelText('Receive TEE'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Receive MUG'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/purchase-orders/po2/receive')).toBe(true));
    const body = calls.find((c) => c.path === '/purchase-orders/po2/receive')!.body as { receiptId: string; lines: unknown[] };
    expect(body.receiptId.length).toBeGreaterThan(8);
    expect(body.lines).toEqual([{ productId: 'p-TEE', quantity: 3 }]);
  });

  it('viewers can read but get no action buttons', async () => {
    auth.role = 'viewer';
    mockApi(routes());
    renderPage();
    await screen.findByText('#1');
    expect(screen.queryByRole('button', { name: 'New purchase order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive' })).not.toBeInTheDocument();
  });
});
