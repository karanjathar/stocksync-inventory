import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAction } from '../hooks';
import { toCents } from '../format';
import { ErrorBanner, Field } from '../components/ui';
import type { Category, CustomFieldDef, Product, TaxRate } from '../api/types';

interface Props {
  product?: Product;
  categories: Category[];
  customFields: CustomFieldDef[];
  /** Tax rates to choose from; the product's current rate stays selectable even if it was deactivated. */
  taxRates?: TaxRate[];
  canUpload: boolean;
  onSaved: (p: Product) => void;
  onCancel: () => void;
}

/** Uploads an image straight to Azure Blob Storage using a short-lived SAS URL from the API. */
async function uploadImage(file: File): Promise<string> {
  const { uploadUrl, blobUrl } = await api<{ uploadUrl: string; blobUrl: string }>('/uploads/image-sas', {
    body: { filename: file.name, contentType: file.type },
  });
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': file.type }, body: file });
  if (!res.ok) throw new Error(`Image upload failed (${res.status})`);
  return blobUrl;
}

export function ProductForm({ product, categories, customFields, taxRates = [], canUpload, onSaved, onCancel }: Props) {
  const [sku, setSku] = useState(product?.sku ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [unit, setUnit] = useState(product?.unit ?? 'pcs');
  const [price, setPrice] = useState(product ? (product.priceCents / 100).toFixed(2) : '');
  const [reorderLevel, setReorderLevel] = useState(String(product?.reorderLevel ?? 0));
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [taxRateId, setTaxRateId] = useState(product?.taxRateId ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(product?.imageUrl ?? null);
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [attributes, setAttributes] = useState<Record<string, string>>(product?.attributes ?? {});
  const [extraKey, setExtraKey] = useState('');
  const { busy, error, setError, run } = useAction();

  const definedKeys = new Set(customFields.map((f) => f.key));
  const extraAttrs = Object.entries(attributes).filter(([k]) => !definedKeys.has(k));
  const setAttr = (k: string, v: string) => setAttributes((a) => ({ ...a, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const priceCents = toCents(price);
    if (Number.isNaN(priceCents)) { setError('Price must be a number with at most 2 decimals, e.g. 19.99'); return; }
    const cleaned = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v.trim() !== ''));
    const body = {
      sku: sku.trim().toUpperCase(), name: name.trim(), description, unit: unit.trim() || 'pcs', priceCents,
      reorderLevel: Number(reorderLevel) || 0, categoryId: categoryId || null, taxRateId: taxRateId || null, imageUrl, isActive, attributes: cleaned,
    };
    const saved = await run(() => product
      ? api<Product>(`/products/${product.id}`, { method: 'PATCH', body })
      : api<Product>('/products', { body }));
    if (saved) onSaved(saved);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const url = await run(() => uploadImage(file));
    if (url) setImageUrl(url);
  };

  return (
    <form className="card grid" onSubmit={submit} aria-label="Product form">
      <h2>{product ? `Edit ${product.sku}` : 'New product'}</h2>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="SKU"><input required value={sku} onChange={(e) => setSku(e.target.value)} placeholder="TEE-RED-M" /></Field>
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Price"><input required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="19.99" /></Field>
        <Field label="Unit"><input value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
        <Field label="Reorder level" hint="Alert when total stock falls to this level (0 = off)">
          <input type="number" min={0} value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />
        </Field>
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">— none —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Tax rate" hint="Added to or included in the price, depending on Settings">
          <select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
            <option value="">— none —</option>
            {taxRates.filter((r) => r.active || r.id === taxRateId).map((r) => <option key={r.id} value={r.id}>{r.name}{r.active ? '' : ' (inactive)'}</option>)}
          </select>
        </Field>
        {customFields.map((f) => (
          <Field key={f.key} label={f.label}>
            {f.type === 'select' ? (
              <select value={attributes[f.key] ?? ''} onChange={(e) => setAttr(f.key, e.target.value)}>
                <option value="">—</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input type={f.type === 'number' ? 'number' : 'text'} value={attributes[f.key] ?? ''} onChange={(e) => setAttr(f.key, e.target.value)} />
            )}
          </Field>
        ))}
        {extraAttrs.map(([k, v]) => (
          <Field key={k} label={k}><input value={v} onChange={(e) => setAttr(k, e.target.value)} /></Field>
        ))}
      </div>
      <div className="row">
        <input aria-label="New attribute name" placeholder="Add attribute (e.g. material)" value={extraKey} onChange={(e) => setExtraKey(e.target.value)} style={{ maxWidth: 260 }} />
        <button type="button" className="small" disabled={!extraKey.trim()} onClick={() => { setAttr(extraKey.trim(), ''); setExtraKey(''); }}>Add attribute</button>
      </div>
      <Field label="Description"><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="row">
        {imageUrl && <img className="thumb" src={imageUrl} alt="" />}
        {canUpload ? (
          <label className="small">Image <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void onFile(e.target.files?.[0])} /></label>
        ) : (
          <Field label="Image URL" hint="Configure Azure Blob Storage to enable uploads">
            <input type="url" value={imageUrl ?? ''} onChange={(e) => setImageUrl(e.target.value || null)} placeholder="https://…" />
          </Field>
        )}
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active (visible in shop &amp; chat)</label>
      </div>
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>{product ? 'Save changes' : 'Create product'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
