import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsProvider } from '../settings';
import { Analytics, RevenueChart } from './Analytics';
import { mockApi } from '../test/setup';

const days = [{ day: '2026-06-01', orders: 1, units: 2, revenueCents: 3000 }, { day: '2026-06-02', orders: 0, units: 0, revenueCents: 0 }, { day: '2026-06-03', orders: 2, units: 4, revenueCents: 6000 }];
const api = {
  '/settings': { businessName: 'S', currency: 'USD' },
  sales: { range: { from: '2026-06-01', to: '2026-06-03' }, days, totals: { orders: 3, units: 6, revenueCents: 9000 }, byChannel: [{ channel: 'whatsapp', orders: 3, revenueCents: 9000 }] },
  best: { products: [{ sku: 'TEE', name: 'T-Shirt', units: 6, revenueCents: 9000 }] },
  margins: { products: [{ sku: 'TEE', name: 'T-Shirt', units: 6, revenueCents: 9000, unitCostCents: 1000, marginCents: 3000, marginPct: 33.3 }, { sku: 'LAMP', name: 'Lamp', units: 1, revenueCents: 500, unitCostCents: null, marginCents: null, marginPct: null }],
    totals: { revenueCents: 9000, costCents: 6000, marginCents: 3000, marginPct: 33.3, unknownCostProducts: 1 } },
  funnel: { conversations: 10, orders: 4, confirmed: 3, paid: 1, rates: { conversationToOrder: 0.4, orderToConfirmed: 0.75, confirmedToPaid: 0.333 } },
  dead: { days: 60, products: [{ sku: 'DUSTY', name: 'Dusty box', inStock: 20, stockValueCents: 2000, daysSinceSold: null }] },
};
describe('RevenueChart', () => {
  it('is an image with a title and description, one bar per day, and every value in text', () => {
    render(<RevenueChart days={days} currency="USD" />);
    const chart = screen.getByRole('img', { name: 'Revenue per day' });
    expect(chart).toHaveAccessibleDescription(/2026-06-01 to 2026-06-03.*\$60\.00/);
    expect(chart.querySelectorAll('rect')).toHaveLength(3);
    expect(within(chart).getByText(/2026-06-03: \$60\.00, 2 orders/)).toBeInTheDocument();
  });
  it('copes with no days', () => {
    render(<RevenueChart days={[]} currency="USD" />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});

describe('Analytics page', () => {
  it('shows totals, tables with proper headers, margins with unknown costs flagged, the funnel and dead stock', async () => {
    const calls = mockApi(new Proxy({} as Record<string, unknown>, { get: (_t, key: string) => {
      if (key === '/settings') return api['/settings'];
      if (key.startsWith('/analytics/sales')) return api.sales;
      if (key.startsWith('/analytics/best-sellers')) return api.best;
      if (key.startsWith('/analytics/margins')) return api.margins;
      if (key.startsWith('/analytics/funnel')) return api.funnel;
      if (key.startsWith('/analytics/dead-stock')) return api.dead;
      return undefined;
    } }));
    render(<SettingsProvider><Analytics /></SettingsProvider>);
    expect(await screen.findByText('$90.00', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/from 3 orders \(6 units\)/)).toBeInTheDocument();
    expect(await screen.findByText(/1 product has no purchase cost yet/)).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByText('10', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('(40% of conversations)')).toBeInTheDocument();
    expect(await screen.findByText('never')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader', { name: 'Revenue' }).length).toBeGreaterThan(1);
    expect(calls.some((c) => c.path.startsWith('/analytics/dead-stock?days=60'))).toBe(true);
    fireEvent.change(screen.getByLabelText(/Not sold for/), { target: { value: '90' } });
    await screen.findByText('never');
    expect(calls.some((c) => c.path.startsWith('/analytics/dead-stock?days=90'))).toBe(true);
  });
});
