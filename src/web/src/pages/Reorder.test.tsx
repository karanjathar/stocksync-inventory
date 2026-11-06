import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Reorder } from './Reorder';
import { mockApi } from '../test/setup';

const auth = vi.hoisted(() => ({ role: 'staff' as 'staff' | 'viewer' }));
vi.mock('../auth', () => ({ useAuth: () => ({ can: (r: string) => r === 'viewer' || auth.role === 'staff', user: { id: 'u', role: auth.role } }) }));

const s = (over: object) => ({ productId: 'p1', sku: 'TEE', name: 'T-Shirt', unit: 'pcs', onHand: 2, incoming: 0, reorderLevel: 10, reorderQuantity: 30, suggestedQuantity: 30, supplierId: 's1', supplierName: 'Acme', lastCostCents: 900, costKnown: true, ...over });
const rows = [s({}), s({ productId: 'p2', sku: 'MUG', name: 'Mug', supplierId: null, supplierName: null, suggestedQuantity: 12 })];
const view = () => render(<MemoryRouter><Reorder /></MemoryRouter>);

describe('Reorder suggestions screen (T63)', () => {
  it('lists low items, preselects those with a supplier and disables those without', async () => {
    auth.role = 'staff';
    mockApi({ '/reorder-suggestions': rows });
    view();
    expect(await screen.findByLabelText('Select TEE')).toBeChecked();
    expect(screen.getByLabelText('Select MUG')).toBeDisabled();
    expect(screen.getByText(/no preferred supplier/i)).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('creates draft purchase orders for the selected items and reports the result', async () => {
    auth.role = 'staff';
    const calls = mockApi({
      '/reorder-suggestions': rows,
      'POST /reorder-suggestions': { orders: [{ id: 'po9', number: 9, supplierName: 'Acme', totalCents: 27000 }], skipped: [{ productId: 'p3', reason: 'No preferred supplier set' }] },
    });
    view();
    await screen.findByLabelText('Select TEE');
    fireEvent.click(screen.getByRole('button', { name: 'Create draft purchase orders' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ productIds: ['p1'] });
    expect(await screen.findByText(/Created 1 draft purchase order/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /#9/ })).toHaveAttribute('href', '/purchase-orders');
    expect(screen.getByText(/No preferred supplier set/)).toBeInTheDocument();
  });

  it('warns when a selected item has no known cost (T107)', async () => {
    auth.role = 'staff';
    mockApi({ '/reorder-suggestions': [s({ lastCostCents: 0, costKnown: false })] });
    view();
    expect(await screen.findByText('cost unknown')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/cost of 0\.00/);
  });

  it('does nothing when nothing is selected', async () => {
    auth.role = 'staff';
    const calls = mockApi({ '/reorder-suggestions': rows });
    view();
    fireEvent.click(await screen.findByLabelText('Select TEE'));
    expect(screen.getByRole('button', { name: 'Create draft purchase orders' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows the server message when nothing could be ordered', async () => {
    auth.role = 'staff';
    mockApi({ '/reorder-suggestions': rows, 'POST /reorder-suggestions': new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'Nothing to order' } }), { status: 409 }) });
    view();
    await screen.findByLabelText('Select TEE');
    fireEvent.click(screen.getByRole('button', { name: 'Create draft purchase orders' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to order');
  });

  it('viewers can read the list but cannot create orders', async () => {
    auth.role = 'viewer';
    mockApi({ '/reorder-suggestions': rows });
    view();
    await screen.findByText('T-Shirt');
    expect(screen.queryByRole('button', { name: 'Create draft purchase orders' })).toBeNull();
    expect(screen.queryByLabelText('Select TEE')).toBeNull();
  });

  it('says so when nothing needs reordering', async () => {
    auth.role = 'staff';
    mockApi({ '/reorder-suggestions': [] });
    view();
    expect(await screen.findByText(/nothing needs reordering/i)).toBeInTheDocument();
  });
});
