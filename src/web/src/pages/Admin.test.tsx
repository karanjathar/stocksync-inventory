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
