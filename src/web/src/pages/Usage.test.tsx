import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Usage } from './Usage';
import { mockApi } from '../test/setup';

const plan = { code: 'FREE', name: 'Free', priceMinor: 0, currency: 'INR', maxProducts: 50, maxUsers: 2, maxChatMessages: 200, maxInvoices: null };

describe('Usage', () => {
  it('shows each meter, flags a reached limit and says unlimited where there is none', async () => {
    mockApi({ '/usage': { plan, period: '2026-11', usage: { products: 10, users: 2, chatMessages: 40, invoices: 7 } } });
    render(<Usage />);
    expect(await screen.findByText('Free plan')).toBeInTheDocument();
    expect(screen.getByText('10 of 50')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.getByText('limit reached')).toBeInTheDocument();
    expect(screen.getByText('7 of unlimited')).toBeInTheDocument();
    expect(screen.getByLabelText('Products used')).toHaveAttribute('value', '20');
  });
  it('shows the price of a paid plan in minor units formatted for display', async () => {
    mockApi({ '/usage': { plan: { ...plan, code: 'PRO', name: 'Pro', priceMinor: 99900 }, period: '2026-11', usage: { products: 0, users: 1, chatMessages: 0, invoices: 0 } } });
    render(<Usage />);
    expect(await screen.findByText(/Pro plan — .*999\.00 \/ month/)).toBeInTheDocument();
  });
});
