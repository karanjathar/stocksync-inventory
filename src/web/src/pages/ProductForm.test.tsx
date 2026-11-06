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
      categoryId: 'c1', taxRateId: null, imageUrl: null, isActive: true, attributes: { color: 'red', weight: '180' },
    });
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
