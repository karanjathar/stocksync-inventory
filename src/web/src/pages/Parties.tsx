import { CrudPage } from '../components/CrudPage';
import { Badge } from '../components/ui';
import type { Customer, Supplier, Warehouse } from '../api/types';

export function Warehouses() {
  return (
    <CrudPage<Warehouse>
      title="Warehouses" entity="warehouse" path="/warehouses"
      fields={[
        { key: 'code', label: 'Code', required: true, placeholder: 'MAIN' },
        { key: 'name', label: 'Name', required: true },
        { key: 'address', label: 'Address' },
      ]}
      columns={[
        { label: 'Code', render: (w) => <strong>{w.code}</strong> },
        { label: 'Name', render: (w) => w.name },
        { label: 'Address', render: (w) => w.address },
      ]}
    />
  );
}

export function Suppliers() {
  return (
    <CrudPage<Supplier>
      title="Suppliers" entity="supplier" path="/suppliers"
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'email', label: 'Email', type: 'email', nullable: true },
        { key: 'phone', label: 'Phone', type: 'tel', nullable: true },
        { key: 'notes', label: 'Notes' },
        { key: 'leadTimeDays', label: 'Delivery time (days)', type: 'number', placeholder: '7' },
      ]}
      columns={[
        { label: 'Name', render: (s) => <strong>{s.name}</strong> },
        { label: 'Email', render: (s) => (s.email ? <a href={`mailto:${s.email}`}>{s.email}</a> : '—') },
        { label: 'Phone', render: (s) => s.phone ?? '—' },
        { label: 'Notes', render: (s) => s.notes },
      ]}
    />
  );
}

export function Customers() {
  return (
    <CrudPage<Customer>
      title="Customers" entity="customer" path="/customers"
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'phone', label: 'Phone', type: 'tel', nullable: true },
        { key: 'email', label: 'Email', type: 'email', nullable: true },
        { key: 'gstin', label: 'GSTIN (business buyers)', nullable: true },
        { key: 'stateCode', label: 'GST state code', nullable: true },
      ]}
      columns={[
        { label: 'Name', render: (c) => <strong>{c.name}</strong> },
        { label: 'Channel', render: (c) => <Badge tone={c.channel === 'manual' ? 'neutral' : 'info'}>{c.channel}</Badge> },
        { label: 'Phone', render: (c) => c.phone ?? '—' },
        { label: 'Email', render: (c) => c.email ?? '—' },
        { label: 'GSTIN', render: (c) => c.gstin ?? '—' },
      ]}
    />
  );
}
