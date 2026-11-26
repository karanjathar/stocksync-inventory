import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Orders } from './Orders';
import { SettingsPage } from './SettingsPage';
import { Inbox } from './Inbox';
import { mockApi } from '../test/setup';

vi.mock('../auth', () => ({ useAuth: () => ({ can: () => true, user: { id: 'u', role: 'admin' } }) }));

const order = { paymentMethod: 'COD', paymentStatus: 'UNPAID', publicToken: 't', id: 'o1', number: 42, customerId: 'c1', customerName: 'Asha', channel: 'whatsapp', status: 'PENDING', warehouseId: null,
  totalCents: 3000, notes: '', createdAt: '2026-11-06T10:00:00Z', updatedAt: '2026-11-06T10:00:00Z',
  items: [{ productId: 'p1', sku: 'TEE', name: 'T-Shirt', quantity: 2, unitPriceCents: 1500 }] };

describe('Orders', () => {
  it('confirms a pending order from the chosen warehouse', async () => {
    const calls = mockApi({
      '/orders': [order],
      '/warehouses': [{ id: 'w1', code: 'MAIN', name: 'Main', address: '' }],
      '/customers': [], '/products': [],
      'POST /orders/o1/confirm': { ...order, status: 'CONFIRMED' },
    });
    render(<MemoryRouter><Orders /></MemoryRouter>);
    const row = (await screen.findByText('#42')).closest('tr')!;
    expect(within(row).getByText('2 × T-Shirt')).toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText('Warehouse for #42'), { target: { value: 'w1' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/orders/o1/confirm')).toBe(true));
    expect(calls.find((c) => c.path === '/orders/o1/confirm')!.body).toEqual({ warehouseId: 'w1' });
  });
});

describe('Settings', () => {
  it('edits alert recipients and custom fields and saves them', async () => {
    const calls = mockApi({
      '/settings': { businessName: 'Shop', currency: 'USD', whatsappNumber: '', defaultWarehouseId: null, alertRecipients: [], customFields: [], payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 } },
      '/payments/config': { razorpayConfigured: false, onlineAvailable: false, codEnabled: true, reason: 'Razorpay keys are not configured on the server.' },
      '/warehouses': [], '/channels': [{ name: 'whatsapp', configured: true }, { name: 'telegram', configured: false }],
      'PUT /settings': (b: unknown) => b,
    });
    render(<SettingsPage />);
    expect(await screen.findByText('whatsapp')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'Corner Shop' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add recipient' }));
    fireEvent.change(screen.getByLabelText('Recipient 1 address'), { target: { value: '15550001111' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }));
    fireEvent.change(screen.getByLabelText('Field 1 key'), { target: { value: 'color' } });
    fireEvent.change(screen.getByLabelText('Field 1 label'), { target: { value: 'Colour' } });
    fireEvent.change(screen.getByLabelText('Field 1 type'), { target: { value: 'select' } });
    fireEvent.change(screen.getByLabelText('Field 1 options'), { target: { value: 'red, blue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      businessName: 'Corner Shop',
      alertRecipients: [{ channel: 'whatsapp', to: '15550001111' }],
      customFields: [{ key: 'color', label: 'Colour', type: 'select', options: ['red', 'blue'] }],
    });
  });
});

describe('Inbox', () => {
  it('groups messages into conversations and sends a reply', async () => {
    const calls = mockApi({
      '/messages?limit=500': [
        { id: 'm2', channel: 'telegram', direction: 'out', externalUser: '77', text: 'Hi there', status: 'ok', createdAt: '2026-11-06T10:01:00Z' },
        { id: 'm1', channel: 'telegram', direction: 'in', externalUser: '77', text: 'help', status: 'ok', createdAt: '2026-11-06T10:00:00Z' },
        { id: 'm0', channel: 'whatsapp', direction: 'in', externalUser: '1555', text: 'stock TEE', status: 'ok', createdAt: '2026-11-06T09:00:00Z' },
      ],
      'POST /messages/send': { status: 'accepted' },
    });
    render(<Inbox />);
    fireEvent.click(await screen.findByRole('button', { name: /telegram · 77/ }));
    expect(screen.getByText('help')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Your order ships today' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/messages/send')).toBe(true));
    expect(calls.find((c) => c.path === '/messages/send')!.body).toEqual({ channel: 'telegram', to: '77', text: 'Your order ships today' });
  });
});

describe('Inbox delivery status (T65)', () => {
  const msg = (id: string, status: string, extra = {}) => ({ id, channel: 'whatsapp', direction: 'out', externalUser: '1555', text: `text ${id}`, status, createdAt: `2026-11-06T10:0${id.slice(1)}:00Z`, ...extra });

  it('shows ticks per status, a failure reason, and retries a failed message', async () => {
    const calls = mockApi({
      '/messages?limit=500': [
        msg('m5', 'failed', { errorCode: '131047', errorMessage: 'Re-engagement message' }),
        msg('m4', 'read'), msg('m3', 'delivered'), msg('m2', 'sent'), msg('m1', 'queued'),
      ],
      'POST /messages/m5/retry': { status: 'queued' },
    });
    render(<Inbox />);
    fireEvent.click(await screen.findByRole('button', { name: /whatsapp · 1555/ }));
    expect(screen.getByLabelText('Message text m1 status')).toHaveTextContent(/sending/i);
    expect(screen.getByLabelText('Message text m2 status')).toHaveTextContent('Sent');
    expect(screen.getByLabelText('Message text m3 status')).toHaveTextContent('Delivered');
    expect(screen.getByLabelText('Message text m4 status')).toHaveTextContent('Read');
    const failed = screen.getByLabelText('Message text m5 status');
    expect(failed).toHaveTextContent('Failed');
    expect(failed).toHaveTextContent('Re-engagement message');
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/messages/m5/retry' && c.method === 'POST')).toBe(true));
  });
});

describe('Settings: WhatsApp templates and maintenance (T65)', () => {
  it('maps an event to a template and edits the cleanup periods', async () => {
    const calls = mockApi({
      '/settings': { businessName: 'Shop', currency: 'INR', whatsappNumber: '', defaultWarehouseId: null, alertRecipients: [], customFields: [],
        payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 }, whatsappTemplates: {}, maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 365 } },
      '/payments/config': { razorpayConfigured: false, onlineAvailable: false, codEnabled: true },
      '/warehouses': [], '/channels': [], 'PUT /settings': (b: unknown) => b,
    });
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Template order_confirmed name'), { target: { value: 'order_confirmed_v1' } });
    fireEvent.change(screen.getByLabelText('Template order_confirmed language'), { target: { value: 'en' } });
    fireEvent.change(screen.getByLabelText('Template order_confirmed parameters'), { target: { value: 'orderNumber, total' } });
    fireEvent.change(screen.getByLabelText('Cancel unpaid online orders after (hours)'), { target: { value: '24' } });
    fireEvent.change(screen.getByLabelText('Keep chat history (days, 0 = forever)'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      whatsappTemplates: { order_confirmed: { name: 'order_confirmed_v1', language: 'en', params: ['orderNumber', 'total'] } },
      maintenance: { unpaidOrderTtlHours: 24, chatRetentionDays: 90 },
    });
  });

  it('still renders when the server has not sent the Release 3 settings yet', async () => {
    mockApi({
      '/settings': { businessName: 'Shop', currency: 'USD', whatsappNumber: '', defaultWarehouseId: null, alertRecipients: [], customFields: [], payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 } },
      '/payments/config': { razorpayConfigured: false, onlineAvailable: false, codEnabled: true }, '/warehouses': [], '/channels': [],
    });
    render(<SettingsPage />);
    expect(await screen.findByLabelText('Template order_confirmed name')).toHaveValue('');
  });
});


describe('GST invoicing UI (T78)', () => {
  it('saves the GST profile from Settings', async () => {
    const calls = mockApi({
      '/settings': { businessName: 'Shop', currency: 'INR', whatsappNumber: '', defaultWarehouseId: null, alertRecipients: [], customFields: [],
        payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 }, whatsappTemplates: {}, maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 365 },
        gst: { legalName: '', gstin: '', address: '', stateCode: '', invoicePrefix: 'INV', pricesIncludeTax: true } },
      '/payments/config': { razorpayConfigured: false, onlineAvailable: false, codEnabled: true }, '/warehouses': [], '/channels': [], 'PUT /settings': (b: unknown) => b,
    });
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('GST legal name'), { target: { value: 'Corner Shop Pvt Ltd' } });
    fireEvent.change(screen.getByLabelText('GSTIN'), { target: { value: '27aapfu0939f1zv' } });
    fireEvent.change(screen.getByLabelText('GST state'), { target: { value: '27' } });
    fireEvent.change(screen.getByLabelText('Invoice prefix'), { target: { value: 'cs' } });
    fireEvent.change(screen.getByLabelText('GST address'), { target: { value: '12 MG Road, Pune' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT')!.body as { gst: unknown }).gst).toEqual({
      legalName: 'Corner Shop Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune', stateCode: '27', invoicePrefix: 'CS', pricesIncludeTax: true });
  });

  it('opens the invoice PDF for a confirmed order by asking for it with POST (issuing is a change)', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    URL.createObjectURL = vi.fn(() => 'blob:invoice');
    URL.revokeObjectURL = vi.fn();
    const confirmed = { ...order, status: 'CONFIRMED' };
    const calls = mockApi({ '/orders': [confirmed], '/warehouses': [], '/customers': [], '/products': [], 'POST /orders/o1/invoice.pdf': { ok: true } });
    render(<MemoryRouter><Orders /></MemoryRouter>);
    const row = (await screen.findByText('#42')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Invoice' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:invoice', '_blank', 'noopener'));
    expect(calls.some((c) => c.path === '/orders/o1/invoice.pdf' && c.method === 'POST')).toBe(true);
  });

  it('pending orders have no Invoice button', async () => {
    mockApi({ '/orders': [order], '/warehouses': [], '/customers': [], '/products': [] });
    render(<MemoryRouter><Orders /></MemoryRouter>);
    const row = (await screen.findByText('#42')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: 'Invoice' })).not.toBeInTheDocument();
  });
});
