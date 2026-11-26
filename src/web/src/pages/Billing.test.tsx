import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Billing } from './Billing';
import { mockApi } from '../test/setup';

const offers = [{ code: 'PRO', name: 'Pro', priceMinor: 99900, currency: 'INR' }, { code: 'BUSINESS', name: 'Business', priceMinor: 299900, currency: 'INR' }];
const base = { configured: true, plan: { code: 'FREE', name: 'Free' }, subscription: null, trialDays: 14, trialAvailable: true, offers };

describe('Billing', () => {
  it('offers a trial on each paid plan and sends only the plan code', async () => {
    const calls = mockApi({ '/billing': base, 'POST /billing/subscribe': { shortUrl: 'about:blank', trialEndsAt: null } });
    render(<Billing />);
    fireEvent.click(await screen.findByRole('button', { name: /Start 14-day trial: Pro/ }));
    await screen.findByText(/Billing — Free plan/);
    expect(calls.find((c) => c.path === '/billing/subscribe')?.body).toEqual({ plan: 'PRO' });
  });

  it('tells the owner when a payment failed and until when they have', async () => {
    mockApi({ '/billing': { ...base, plan: { code: 'PRO', name: 'Pro' }, subscription: { status: 'PAST_DUE', planCode: 'PRO', pendingPlanCode: null, trialEndsAt: null, currentPeriodEnd: null, graceEndsAt: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false, shortUrl: null } } });
    render(<Billing />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Payment failed/);
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull();
  });

  it('lets an active subscriber switch plan or cancel', async () => {
    const calls = mockApi({ '/billing': { ...base, plan: { code: 'PRO', name: 'Pro' }, trialAvailable: false, subscription: { status: 'ACTIVE', planCode: 'PRO', pendingPlanCode: null, trialEndsAt: null, currentPeriodEnd: '2026-12-20T00:00:00Z', graceEndsAt: null, cancelAtPeriodEnd: false, shortUrl: null } },
      'POST /billing/change': {} });
    render(<Billing />);
    expect(screen.queryByRole('button', { name: /Subscribe: Pro/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /Switch to Business/ }));
    await screen.findByText(/Billing — Pro plan/);
    expect(calls.find((c) => c.path === '/billing/change')?.body).toEqual({ plan: 'BUSINESS' });
    expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
  });
});
