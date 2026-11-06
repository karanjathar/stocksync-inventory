import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Returns } from './Returns';
import { mockApi } from '../test/setup';

vi.mock('../auth', () => ({ useAuth: () => ({ can: () => true, user: { id: 'u', role: 'staff' } }) }));

const ret = (over: object = {}) => ({
  id: 'r1', number: 5, orderId: 'o1', orderNumber: 12, creditTotalCents: 1770, creditTaxCents: 270, creditSubtotalCents: 1500, refundStatus: 'REFUND_DUE', refundCents: 1770,
  reason: 'Wrong size', createdAt: '2026-11-06T10:00:00Z', items: [{ sku: 'TEE', name: 'T-Shirt', quantity: 1 }], creditNote: { id: 'cn1', number: 'CN-2026-000001' }, ...over,
});
const open = vi.fn();
beforeEach(() => { open.mockReset().mockReturnValue({}); vi.stubGlobal('open', open); URL.createObjectURL = vi.fn(() => 'blob:doc'); URL.revokeObjectURL = vi.fn(); });
const view = () => render(<MemoryRouter><Returns /></MemoryRouter>);

describe('Returns page (T69)', () => {
  it('lists returns with their credit note and refund state', async () => {
    mockApi({ '/returns': [ret(), ret({ id: 'r2', number: 6, refundStatus: 'NOT_REQUIRED', refundCents: 0, creditNote: { id: 'cn2', number: 'CN-2026-000002' } })], '/settings': { currency: 'USD' } });
    view();
    const row = (await screen.findByText('#5')).closest('tr')!;
    expect(within(row).getByText(/order #12/i)).toBeInTheDocument();
    expect(within(row).getByText('CN-2026-000001')).toBeInTheDocument();
    expect(within(row).getByText(/17\.70/)).toBeInTheDocument();
    expect(within(row).getByText('refund due')).toBeInTheDocument();
    const other = screen.getByText('#6').closest('tr')!;
    expect(within(other).queryByRole('button', { name: 'Mark refunded' })).toBeNull();
  });

  it('marks a refund as done only after confirmation', async () => {
    const calls = mockApi({ '/returns': [ret()], '/settings': { currency: 'USD' }, 'POST /returns/r1/refunded': ret({ refundStatus: 'REFUNDED' }) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark refunded' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Mark refunded' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/returns/r1/refunded')).toBe(true));
  });

  it('prints the credit note', async () => {
    const calls = mockApi({ '/returns': [ret()], '/settings': { currency: 'USD' }, '/credit-notes/cn1/print': new Response('<p>CN</p>') });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Credit note' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:doc', '_blank'));
    expect(calls.some((c) => c.path === '/credit-notes/cn1/print')).toBe(true);
  });

  it('filters to returns awaiting a refund', async () => {
    const calls = mockApi({ '/returns': [ret()], '/returns?refundStatus=REFUND_DUE': [ret()], '/settings': { currency: 'USD' } });
    view();
    await screen.findByText('#5');
    fireEvent.click(screen.getByRole('tab', { name: 'refund due' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/returns?refundStatus=REFUND_DUE')).toBe(true));
  });
});
