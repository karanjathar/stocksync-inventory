import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProductForm } from './ProductForm';
import { mockApi } from '../test/setup';
import type { CustomFieldDef } from '../api/types';

const fields: CustomFieldDef[] = [
  { key: 'color', label: 'Colour', type: 'select', options: ['red', 'blue'] },
  { key: 'weight', label: 'Weight (g)', type: 'number' },
];

describe('ProductForm', () => {
  it('renders dynamic custom fields and submits attributes and cents', async () => {
    const calls = mockApi({ 'POST /products': (b: unknown) => ({ id: 'new', ...(b as object) }) });
    const onSaved = vi.fn();
    render(<ProductForm categories={[{ id: 'c1', name: 'Apparel' }]} customFields={fields} canUpload={false} onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'tee-red' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Red Tee' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '19.99' } });
    fireEvent.change(screen.getByLabelText('Reorder level'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: 'red' } });
    fireEvent.change(screen.getByLabelText('Weight (g)'), { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0]!.body).toEqual({
      sku: 'TEE-RED', name: 'Red Tee', description: '', unit: 'pcs', priceCents: 1999, reorderLevel: 4,
      categoryId: 'c1', imageUrl: null, isActive: true, attributes: { color: 'red', weight: '180' }, barcode: null, hsnCode: null, gstRateBp: 0,
    });
  });

  it('sends a typed barcode and shows the server\'s duplicate error', async () => {
    const calls = mockApi({ 'POST /products': () => new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'A record with these unique values already exists' } }), { status: 409 }) });
    render(<ProductForm categories={[]} customFields={[]} canUpload={false} onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'A1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Barcode'), { target: { value: ' 4006381333931 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    expect(calls[0]!.body).toMatchObject({ barcode: '4006381333931' });
  });

  it('sends the HSN code and GST rate (in basis points) and keeps an unusual existing rate selectable', async () => {
    const calls = mockApi({ 'POST /products': (b: unknown) => ({ id: 'new', ...(b as object) }) });
    const onSaved = vi.fn();
    render(<ProductForm categories={[]} customFields={[]} canUpload={false} onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'A1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '118' } });
    fireEvent.change(screen.getByLabelText('HSN/SAC code'), { target: { value: ' 610910 ' } });
    fireEvent.change(screen.getByLabelText('GST rate'), { target: { value: '1800' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0]!.body).toMatchObject({ hsnCode: '610910', gstRateBp: 1800, priceCents: 11800 });
  });

  it('validates price before submitting', async () => {
    const calls = mockApi({});
    render(<ProductForm categories={[]} customFields={[]} canUpload={false} onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'A1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '12.345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/price/i);
    expect(calls).toHaveLength(0);
  });
});
