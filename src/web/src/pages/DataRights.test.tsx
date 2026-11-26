import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DataRights } from './DataRights';
import { mockApi } from '../test/setup';

describe('DataRights', () => {
  it('only enables the delete button when the web address matches and a password is typed, and sends both', async () => {
    let requested = false;
    const calls = mockApi({
      '/data/deletion': () => ({ slug: 'corner', requested, requestedAt: null, eraseAfter: requested ? '2026-12-26T00:00:00Z' : null, holdDays: 30 }),
      'POST /data/deletion': () => { requested = true; return {}; },
    });
    render(<DataRights />);
    const button = await screen.findByRole('button', { name: 'Request deletion' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type corner to confirm'), { target: { value: 'corne' } });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type corner to confirm'), { target: { value: 'corner' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await screen.findByText(/Deletion requested/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ password: 'pw', confirmSlug: 'corner' });
  });

  it('lets the owner cancel a pending deletion', async () => {
    let requested = true;
    mockApi({ '/data/deletion': () => ({ slug: 'corner', requested, requestedAt: null, eraseAfter: '2026-12-26T00:00:00Z', holdDays: 30 }), 'DELETE /data/deletion': () => { requested = false; return {}; } });
    render(<DataRights />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel deletion' }));
    expect(await screen.findByRole('button', { name: 'Request deletion' })).toBeInTheDocument();
  });

  it('renders nothing when the server refuses (not an administrator)', async () => {
    mockApi({});
    const { container } = render(<DataRights />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
