import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth';
import { setToken } from '../api/client';
import { OnboardingCard } from './Onboarding';
import { mockApi } from '../test/setup';

const steps = (done: string[]) => ['profile', 'warehouse', 'product', 'whatsapp', 'gst'].map((id) => ({ id, done: done.includes(id), optional: id === 'gst' }));
const admin = { id: 'u1', email: 'a@b.c', name: 'Ann', role: 'admin', createdAt: '2026-01-01T00:00:00Z' };
function renderCard() {
  setToken('t');
  return render(<AuthProvider><MemoryRouter><OnboardingCard /></MemoryRouter></AuthProvider>);
}
const withMe = (routes: Record<string, unknown>) => mockApi({ '/auth/me': admin, ...routes });

describe('OnboardingCard', () => {
  it('shows progress, links to the next steps and adds sample data', async () => {
    let demo = false;
    const calls = withMe({
      '/onboarding': () => ({ steps: steps(['profile']), dismissed: false, demo, complete: false }),
      'POST /onboarding/demo': () => { demo = true; return { created: true, products: 6 }; },
    });
    renderCard();
    expect(await screen.findByText('Get started — 1 of 5 done')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a warehouse' })).toHaveAttribute('href', '/warehouses');
    expect(screen.getByText('optional')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add sample data to explore' }));
    expect(await screen.findByRole('button', { name: 'Remove sample data' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/onboarding/demo')).toBe(true);
  });

  it('can be hidden and shown again', async () => {
    let dismissed = false;
    withMe({
      '/onboarding': () => ({ steps: steps([]), dismissed, demo: false, complete: false }),
      'POST /onboarding/dismiss': (b: unknown) => { dismissed = (b as { dismissed: boolean }).dismissed; return {}; },
    });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Hide this guide' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show setup guide' }));
    expect(await screen.findByText(/Get started/)).toBeInTheDocument();
  });

  it('renders nothing when finished, or when the server says no (not an admin)', async () => {
    withMe({ '/onboarding': { steps: steps(['profile', 'warehouse', 'product', 'whatsapp']), dismissed: false, demo: false, complete: true } });
    const { container } = renderCard();
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
  it('is silent when it cannot load', async () => {
    withMe({});
    const { container } = renderCard();
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
