import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Platform } from './Platform';
import { mockApi } from '../test/setup';

const row = { id: 't1', slug: 'corner', name: 'Corner Shop', status: 'ACTIVE', plan: 'FREE', subscription: null, chatMessages: 12, invoices: 3, createdAt: '2026-01-01T00:00:00Z' };

describe('Platform console', () => {
  it('signs in separately, lists businesses with usage, and changes plan and status', async () => {
    const calls = mockApi({ 'POST /platform/login': { token: 'ops-token' }, '/platform/tenants': [row], '/platform/plans': [{ code: 'FREE', active: true }, { code: 'PRO', active: true }], 'PATCH /platform/tenants/t1': {} });
    render(<Platform />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@x.y' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Corner Shop')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/platform/tenants')?.headers.authorization).toBe('Bearer ops-token');
    fireEvent.change(screen.getByLabelText('Plan for Corner Shop'), { target: { value: 'PRO' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    await screen.findByText('Corner Shop');
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ plan: 'PRO' }, { status: 'SUSPENDED' }]);
  });
});
