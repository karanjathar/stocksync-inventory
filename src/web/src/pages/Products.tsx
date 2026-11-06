import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { money } from '../format';
import { Badge, Card, Empty, ErrorBanner, Page } from '../components/ui';
import { ProductForm } from './ProductForm';
import type { Category, Product, TaxRate } from '../api/types';

export function Products() {
  const { can } = useAuth();
  const { settings } = useSettings();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const qs = new URLSearchParams({ ...(search && { search }), ...(categoryId && { categoryId }), ...(lowOnly && { lowStock: 'true' }) }).toString();
  const products = useApi<Product[]>(`/products${qs ? `?${qs}` : ''}`);
  const taxRates = useApi<TaxRate[]>('/tax-rates');
  const categories = useApi<Category[]>('/categories');
  const uploads = useApi<{ configured: boolean }>(can('staff') ? '/uploads/status' : null);
  const action = useAction();
  const canWrite = can('staff');
  const catName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name ?? '—';

  const addCategory = async () => {
    if (!newCategory.trim()) return;
    const ok = await action.run(() => api<Category>('/categories', { body: { name: newCategory.trim() } }));
    if (ok) { setNewCategory(''); categories.reload(); }
  };
  const removeProduct = async (p: Product) => {
    if (!window.confirm(`Delete ${p.sku}? Stock history for this product is deleted too.`)) return;
    await action.run(() => api(`/products/${p.id}`, { method: 'DELETE' }));
    products.reload();
  };

  return (
    <Page title="Products" actions={canWrite && <button className="primary" onClick={() => setEditing('new')}>+ New product</button>}>
      <ErrorBanner error={products.error ?? action.error} />
      {editing && (
        <ProductForm
          product={editing === 'new' ? undefined : editing}
          categories={categories.data ?? []}
          customFields={settings.customFields}
          taxRates={taxRates.data ?? []}
          canUpload={uploads.data?.configured === true}
          onSaved={() => { setEditing(null); products.reload(); }}
          onCancel={() => setEditing(null)}
        />
      )}
      <Card>
        <div className="row" style={{ marginBottom: 12 }}>
          <input type="search" placeholder="Search SKU, name or description…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} aria-label="Search products" />
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ maxWidth: 200 }} aria-label="Filter by category">
            <option value="">All categories</option>
            {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low stock only</label>
        </div>
        {products.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th /><th>Product</th><th>Category</th><th>Attributes</th><th className="num">Price</th><th className="num">Stock</th><th /></tr></thead>
              <tbody>
                {products.data.map((p) => {
                  const low = p.reorderLevel > 0 && p.totalQuantity <= p.reorderLevel;
                  return (
                    <tr key={p.id}>
                      <td>{p.imageUrl ? <img className="thumb" src={p.imageUrl} alt="" /> : <span className="thumb" />}</td>
                      <td><strong>{p.name}</strong> {!p.isActive && <Badge>inactive</Badge>}<div className="muted small">{p.sku}</div></td>
                      <td>{catName(p.categoryId)}</td>
                      <td><div className="attrs">{Object.entries(p.attributes).map(([k, v]) => <Badge key={k}>{k}: {v}</Badge>)}</div></td>
                      <td className="num">{money(p.priceCents, settings.currency)}</td>
                      <td className="num">{low ? <Badge tone="warn">{p.totalQuantity} {p.unit}</Badge> : `${p.totalQuantity} ${p.unit}`}</td>
                      <td className="num">{canWrite && (
                        <span className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="small" onClick={() => setEditing(p)}>Edit</button>
                          <button className="small danger" onClick={() => void removeProduct(p)}>Delete</button>
                        </span>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty>{products.loading ? 'Loading…' : 'No products yet.'}</Empty>}
      </Card>
      {canWrite && (
        <Card title="Categories">
          <div className="row">
            {categories.data?.map((c) => (
              <Badge key={c.id}>{c.name} <button className="ghost small" aria-label={`Delete ${c.name}`} onClick={() => void action.run(() => api(`/categories/${c.id}`, { method: 'DELETE' })).then(categories.reload)}>×</button></Badge>
            ))}
            <input placeholder="New category" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} style={{ maxWidth: 200 }} aria-label="New category" />
            <button className="small" onClick={() => void addCategory()}>Add</button>
          </div>
        </Card>
      )}
    </Page>
  );
}
