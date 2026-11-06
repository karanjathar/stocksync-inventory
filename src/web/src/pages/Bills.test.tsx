import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Bills } from './Bills';
import { mockApi } from '../test/setup';

const auth = vi.hoisted(() => ({ role: 'staff' as 'staff' | 'viewer' }));
vi.mock('../auth', () => ({ useAuth: () => ({ can: (r: string) => r === 'viewer' || auth.role === 'staff', user: { id: 'u', role: auth.role } }) }));

const bill = (over: object = {}) => ({
  id: 'b1', number: 3, supplierId: 's1', supplierName: 'Acme', purchaseOrderId: null, status: 'UNPAID', totalCents: 10000, paidCents: 2500,
  dueDate: '2026-12-01', createdAt: '2026-11-06T10:00:00Z', payments: [], ...over,
});
const base = (bills: object[]) => ({
  '/bills': bills,
  '/reports/payables': { suppliers: [{ supplierId: 's1', supplierName: 'Acme', openCents: 7500, overdueCents: 2000, billCount: 1 }], totalOpenCents: 7500, totalOverdueCents: 2000 },
  '/suppliers': [{ id: 's1', name: 'Acme' }],
  '/purchase-orders': [
    { id: 'po1', number: 7, supplierName: 'Acme', status: 'RECEIVED', totalCents: 9000 },
    { id: 'po2', number: 8, supplierName: 'Acme', status: 'DRAFT', totalCents: 100 },
  ],
  '/settings': { currency: 'INR' },
});
const view = () => render(<MemoryRouter><Bills /></MemoryRouter>);

describe('Bills screen (T63)', () => {
  it('shows what is owed per supplier and the bills with their balance', async () => {
    auth.role = 'staff';
    mockApi(base([bill()]));
    view();
    const summary = (await screen.findByText('Owed to suppliers')).closest('.card')!;
    expect(within(summary as HTMLElement).getAllByText(/75\.00/).length).toBeGreaterThan(0);
    expect(within(summary as HTMLElement).getAllByText(/20\.00 overdue/).length).toBeGreaterThan(0);
    expect(within(summary as HTMLElement).getByText('Acme')).toBeInTheDocument();
    const row = (await screen.findByText('#3')).closest('tr')!;
    expect(within(row).getByText('UNPAID')).toBeInTheDocument();
    expect(within(row).getByText(/75\.00 due/)).toBeInTheDocument();
  });

  it('records a payment in minor units with a request id that survives a retry', async () => {
    auth.role = 'staff';
    let attempt = 0;
    const calls = mockApi({
      ...base([bill()]),
      'POST /bills/b1/payments': () => (++attempt === 1
        ? new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal server error' } }), { status: 500 })
        : bill({ paidCents: 4000, status: 'PARTIAL' })),
    });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Pay' }));
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '15.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error');
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    const [first, second] = calls.filter((c) => c.method === 'POST');
    expect(first!.body).toMatchObject({ amountCents: 1500, method: 'bank' });
    expect((second!.body as { requestId: string }).requestId).toBe((first!.body as { requestId: string }).requestId);
  });

  it('refuses to pay more than is owed without calling the API', async () => {
    auth.role = 'staff';
    const calls = mockApi(base([bill()]));
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Pay' }));
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '75.01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/more than/i);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a bill from a purchase order that has received goods', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...base([]), 'POST /bills': bill() });
    view();
    fireEvent.click(await screen.findByRole('button', { name: '+ New bill' }));
    const select = await screen.findByLabelText('Purchase order');
    await within(select).findByRole('option', { name: /#7/ });
    expect(within(select).queryByText(/#8/)).toBeNull(); // a DRAFT order has nothing received
    fireEvent.change(select, { target: { value: 'po1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bill' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ purchaseOrderId: 'po1' });
  });

  it('creates a standalone bill with an amount and due date', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...base([]), 'POST /bills': bill() });
    view();
    fireEvent.click(await screen.findByRole('button', { name: '+ New bill' }));
    fireEvent.click(await screen.findByLabelText('Not linked to a purchase order'));
    await screen.findByRole('option', { name: 'Acme' });
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25.50' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-12-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bill' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ supplierId: 's1', amountCents: 2550, dueDate: '2026-12-15' });
  });

  it('voids an unpaid bill after confirmation, but not one with payments', async () => {
    auth.role = 'staff';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = mockApi({ ...base([bill({ id: 'b2', number: 4, paidCents: 0 }), bill()]), 'POST /bills/b2/void': bill({ status: 'VOID' }) });
    view();
    const unpaid = (await screen.findByText('#4')).closest('tr')!;
    expect(within((await screen.findByText('#3')).closest('tr')!).queryByRole('button', { name: 'Void' })).toBeNull();
    fireEvent.click(within(unpaid).getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/bills/b2/void')).toBe(true));
  });
});
