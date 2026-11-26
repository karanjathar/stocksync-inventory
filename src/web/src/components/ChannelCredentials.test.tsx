import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ChannelCredentials } from './ChannelCredentials';
import { mockApi } from '../test/setup';

const config = (over: object = {}) => ({
  tenantId: 'tid-1', enabled: true,
  urls: { meta: 'https://app.example.com/webhooks/meta/tid-1', telegram: 'https://app.example.com/webhooks/telegram/tid-1', razorpay: 'https://app.example.com/webhooks/razorpay/tid-1' },
  kinds: [
    { kind: 'meta', configured: false, hint: null, source: null }, { kind: 'whatsapp', configured: true, hint: '1111', source: 'saved' },
    { kind: 'messenger', configured: false, hint: null, source: null }, { kind: 'instagram', configured: false, hint: null, source: null },
    { kind: 'telegram', configured: true, hint: 'XYZ9', source: 'server' }, { kind: 'razorpay', configured: false, hint: null, source: null },
  ], ...over,
});
const form = (title: string) => screen.getByRole('form', { name: `${title} credentials` });

describe('Channel credentials card', () => {
  it('shows what is set and only the last four characters, plus this business\'s own webhook URLs', async () => {
    mockApi({ '/channel-config': config() });
    render(<ChannelCredentials />);
    const wa = await screen.findByRole('form', { name: 'WhatsApp credentials' });
    expect(within(wa).getByText('Saved ••••1111')).toBeInTheDocument();
    expect(within(form('Telegram')).getByText('Set on the server')).toBeInTheDocument();
    expect(within(form('Razorpay')).getByText('Not set')).toBeInTheDocument();
    expect(within(form('Razorpay')).getByText('https://app.example.com/webhooks/razorpay/tid-1')).toBeInTheDocument();
    expect(within(wa).getByLabelText('WhatsApp Access token')).toHaveValue('');           // secrets are never pre-filled
    expect(within(wa).getByLabelText('WhatsApp Access token')).toHaveAttribute('type', 'password');
  });

  it('saves a credential, then clears the fields: a saved secret is never shown again', async () => {
    const calls = mockApi({ '/channel-config': config(), 'PUT /channel-config/razorpay': { kind: 'razorpay', configured: true } });
    render(<ChannelCredentials />);
    const rz = await screen.findByRole('form', { name: 'Razorpay credentials' });
    const save = within(rz).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();                                                              // incomplete
    fireEvent.change(within(rz).getByLabelText('Razorpay Key ID'), { target: { value: ' rzp_test_ABCD ' } });
    fireEvent.change(within(rz).getByLabelText('Razorpay Key secret'), { target: { value: 'the-secret' } });
    fireEvent.change(within(rz).getByLabelText('Razorpay Webhook secret'), { target: { value: 'the-hook' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ keyId: 'rzp_test_ABCD', keySecret: 'the-secret', webhookSecret: 'the-hook' });
    expect(await within(rz).findByRole('status')).toHaveTextContent(/no longer shown/);
    expect(within(rz).getByLabelText('Razorpay Key secret')).toHaveValue('');
    expect(document.body.textContent).not.toContain('the-secret');
  });

  it('removes only saved credentials, after confirmation (server-set ones cannot be removed here)', async () => {
    const calls = mockApi({ '/channel-config': config(), 'DELETE /channel-config/whatsapp': {} });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ChannelCredentials />);
    const wa = await screen.findByRole('form', { name: 'WhatsApp credentials' });
    expect(within(form('Telegram')).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    fireEvent.click(within(wa).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/channel-config/whatsapp')).toBe(true));
  });

  it('does nothing when removal is declined', async () => {
    const calls = mockApi({ '/channel-config': config() });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ChannelCredentials />);
    fireEvent.click(within(await screen.findByRole('form', { name: 'WhatsApp credentials' })).getByRole('button', { name: 'Remove' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('explains when the server cannot store credentials, and shows server validation errors', async () => {
    mockApi({ '/channel-config': config({ enabled: false }), 'PUT /channel-config/whatsapp': () => new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } }), { status: 400 }) });
    render(<ChannelCredentials />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/ENCRYPTION_KEY/);
    const wa = screen.getByRole('form', { name: 'WhatsApp credentials' });
    fireEvent.change(within(wa).getByLabelText('WhatsApp Phone number ID'), { target: { value: '123456' } });
    fireEvent.change(within(wa).getByLabelText('WhatsApp Access token'), { target: { value: 'tok' } });
    fireEvent.click(within(wa).getByRole('button', { name: 'Replace' }));
    expect(await within(wa).findByRole('alert')).toBeInTheDocument();
  });

  it('shows a quiet message if the configuration cannot be loaded', async () => {
    mockApi({});
    render(<ChannelCredentials />);
    expect(await screen.findByText(/Could not load channel credentials/)).toBeInTheDocument();
  });
});
