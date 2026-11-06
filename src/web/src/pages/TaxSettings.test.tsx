import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';
import { ProductForm } from './ProductForm';
import { mockApi } from '../test/setup';

vi.mock('../auth', () => ({ useAuth: () => ({ can: () => true, user: { id: 'u', role: 'admin' } }) }));
vi.mock('../settings', () => ({ useSettings: () => ({ settings: { currency: 'USD' }, reload: () => {} }) }));

const settings = (over: object = {}) => ({
  businessName: 'Shop', currency: 'INR', pricesIncludeTax: false, taxId: '', businessAddress: '', whatsappNumber: '', defaultWarehouseId: null,
  alertRecipients: [], customFields: [], payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 }, ...over,
});
const rates = [{ id: 't18', name: 'GST 18%', rateBp: 1800, active: true }, { id: 't5', name: 'GST 5%', rateBp: 500, active: true }, { id: 'told', name: 'Old 12%', rateBp: 1200, active: false }];
const base = (extra: Record<string, unknown> = {}) => ({
  '/settings': settings(), '/warehouses': [], '/channels': [], '/payments/config': { razorpayConfigured: true, onlineAvailable: true, codEnabled: true }, '/tax-rates': rates, ...extra,
});

describe('Settings: tax (T69)', () => {
  it('saves the tax id, address and the prices-include-tax switch', async () => {
    const calls = mockApi({ ...base(), 'PUT /settings': settings() });
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Tax ID (GSTIN)'), { target: { value: '29ABCDE1234F1Z5' } });
    fireEvent.change(screen.getByLabelText('Business address'), { target: { value: '12 MG Road' } });
    fireEvent.click(screen.getByLabelText(/Prices already include tax/));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ taxId: '29ABCDE1234F1Z5', businessAddress: '12 MG Road', pricesIncludeTax: true });
  });

  it('lists tax rates and adds one, converting percent to basis points', async () => {
    const calls = mockApi({ ...base(), 'POST /tax-rates': { id: 'tnew', name: 'GST 12.5%', rateBp: 1250, active: true } });
    render(<SettingsPage />);
    const card = (await screen.findByText('Tax rates')).closest('.card') as HTMLElement;
    expect(await within(card).findByText('GST 18%')).toBeInTheDocument();
    expect(within(card).getByText('18%')).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText('Tax rate name'), { target: { value: 'GST 12.5%' } });
    fireEvent.change(within(card).getByLabelText('Rate (%)'), { target: { value: '12.5' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Add tax rate' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/tax-rates')).toBe(true));
    expect(calls.find((c) => c.path === '/tax-rates' && c.method === 'POST')!.body).toEqual({ name: 'GST 12.5%', rateBp: 1250 });
  });

  it('refuses a bad rate without calling the API', async () => {
    const calls = mockApi(base());
    render(<SettingsPage />);
    const card = (await screen.findByText('Tax rates')).closest('.card') as HTMLElement;
    fireEvent.change(within(card).getByLabelText('Tax rate name'), { target: { value: 'Bad' } });
    for (const bad of ['abc', '101', '-1', '1.234']) {
      fireEvent.change(within(card).getByLabelText('Rate (%)'), { target: { value: bad } });
      fireEvent.click(within(card).getByRole('button', { name: 'Add tax rate' }));
      expect(await within(card).findByText(/rate must be/i)).toBeInTheDocument();
    }
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('deactivates and reactivates a rate', async () => {
    const calls = mockApi({ ...base(), 'PATCH /tax-rates/t5': { ...rates[1], active: false }, 'PATCH /tax-rates/told': { ...rates[2], active: true } });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate GST 5%' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/tax-rates/t5')).toBe(true));
    expect(calls.find((c) => c.path === '/tax-rates/t5')!.body).toEqual({ active: false });
    fireEvent.click(screen.getByRole('button', { name: 'Activate Old 12%' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/tax-rates/told')).toBe(true));
    expect(calls.find((c) => c.path === '/tax-rates/told')!.body).toEqual({ active: true });
  });

  it('still renders when tax rates cannot be loaded', async () => {
    mockApi({ ...base(), '/tax-rates': new Response(JSON.stringify({ error: { code: 'X', message: 'nope' } }), { status: 500 }) });
    render(<SettingsPage />);
    expect(await screen.findByText('Tax rates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeInTheDocument();
  });
});

describe('Product form: tax rate (T69)', () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'tee' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tee' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '15.00' } });
  };

  it('offers active rates, sends the chosen one, and none by default', async () => {
    const calls = mockApi({ 'POST /products': (b: unknown) => ({ id: 'n', ...(b as object) }) });
    render(<ProductForm categories={[]} customFields={[]} taxRates={rates} canUpload={false} onSaved={() => {}} onCancel={() => {}} />);
    const select = screen.getByLabelText('Tax rate');
    expect(within(select).queryByText(/Old 12%/)).toBeNull();
    fireEvent.change(select, { target: { value: 't18' } });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ taxRateId: 't18' });
  });

  it('keeps a product\'s current rate selectable even if it was deactivated, and can clear it', async () => {
    const calls = mockApi({ 'PATCH /products/p1': (b: unknown) => ({ id: 'p1', ...(b as object) }) });
    const product = { id: 'p1', sku: 'TEE', name: 'Tee', description: '', categoryId: null, unit: 'pcs', priceCents: 1500, taxRateId: 'told', reorderLevel: 0, imageUrl: null, attributes: {}, isActive: true, totalQuantity: 0 };
    render(<ProductForm product={product as never} categories={[]} customFields={[]} taxRates={rates} canUpload={false} onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText('Tax rate')).toHaveValue('told');
    fireEvent.change(screen.getByLabelText('Tax rate'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ taxRateId: null });
  });
});
