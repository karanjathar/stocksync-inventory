import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Dashboard } from './Dashboard';
import { mockApi } from '../test/setup';

const auth = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'staff' }));
vi.mock('../auth', () => ({ useAuth: () => ({ can: (r: string) => r !== 'admin' || auth.role === 'admin', user: { id: 'u', role: auth.role } }) }));
const base = {
  '/dashboard': { productCount: 1, totalUnits: 1, stockValueCents: 100, lowStockCount: 0, pendingOrders: 0, ordersToday: 0 },
  '/products?lowStock=true': [], '/orders?status=PENDING': [],
};

describe('Dashboard', () => {
  const ops = { queue: { pending: 3, running: 1, dead: 0, oldestPendingSec: 12 }, messages: { failed24h: 2, queued: 1 }, maintenance: [{ task: 'prune', ranAt: '2026-11-26T03:00:00Z', result: {} }] };

  it('shows system health to admins', async () => {
    auth.role = 'admin';
    mockApi({ ...base, '/ops/status': ops });
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(await screen.findByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText(/3 waiting · 1 running · 0 stuck/)).toBeInTheDocument();
    expect(screen.getByText(/failed messages \(24 h\)/)).toBeInTheDocument();
    expect(screen.getByText(/prune:/)).toBeInTheDocument();
  });

  it('flags stuck jobs and never requests ops status for non-admins', async () => {
    auth.role = 'admin';
    mockApi({ ...base, '/ops/status': { ...ops, queue: { ...ops.queue, dead: 2 } } });
    const { unmount } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    unmount();
    auth.role = 'staff';
    const calls = mockApi(base);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByText('Active products');
    expect(calls.some((c) => c.path === '/ops/status')).toBe(false);
    expect(screen.queryByText('System health')).not.toBeInTheDocument();
  });

  it('renders KPIs, low-stock products and pending orders', async () => {
    auth.role = 'staff';
    mockApi({
      '/dashboard': { productCount: 12, totalUnits: 340, stockValueCents: 1234500, lowStockCount: 2, pendingOrders: 3, ordersToday: 5 },
      '/products?lowStock=true': [{ id: 'p1', sku: 'TEE', name: 'T-Shirt', totalQuantity: 2, reorderLevel: 5, unit: 'pcs' }],
      '/orders?status=PENDING': [{ id: 'o1', number: 17, customerName: 'Asha', channel: 'whatsapp', totalCents: 3000, status: 'PENDING', items: [], createdAt: '2026-11-06T10:00:00Z' }],
    });
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(await screen.findByText('340')).toBeInTheDocument();
    expect(screen.getByText('$12,345.00')).toBeInTheDocument();
    expect(screen.getByText('Low stock').nextSibling).toHaveTextContent('2');
    expect(await screen.findByText('T-Shirt')).toBeInTheDocument();
    expect(await screen.findByText('#17')).toBeInTheDocument();
    expect(screen.getByText('whatsapp')).toBeInTheDocument();
  });
});
