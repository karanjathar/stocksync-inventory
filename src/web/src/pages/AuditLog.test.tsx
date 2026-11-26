import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AuditLog } from './AuditLog';
import { mockApi } from '../test/setup';

const e = (id: string, action: string) => ({ id, at: '2026-11-26T10:00:00Z', actor: 'admin@a.test', action, entityId: null, detail: { fields: ['priceCents'], values: { priceCents: 1250 } } });

describe('AuditLog', () => {
  it('lists changes with their safe values and pages to older entries', async () => {
    const calls = mockApi({
      '/audit-log?limit=50': { entries: [e('1', 'PATCH /products/:id')], next: '2026-11-26 10:00:00+00|11111111-1111-4111-8111-111111111111' },
      '/audit-log?limit=50&before=2026-11-26+10%3A00%3A00%2B00%7C11111111-1111-4111-8111-111111111111': { entries: [e('2', 'PUT /settings')], next: null },
    });
    render(<AuditLog />);
    expect(await screen.findByText('PATCH /products/:id')).toBeInTheDocument();
    expect(screen.getByText('priceCents: 1250')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    expect(await screen.findByText('PUT /settings')).toBeInTheDocument();
    expect(calls).toHaveLength(2);
  });
  it('says so when nothing has happened yet', async () => {
    mockApi({ '/audit-log?limit=50': { entries: [], next: null } });
    render(<AuditLog />);
    expect(await screen.findByText('No activity recorded yet.')).toBeInTheDocument();
  });
});
