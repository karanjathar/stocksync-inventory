import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { Card, Empty, ErrorBanner, Field, Page } from './ui';

export interface CrudField<T> { key: keyof T & string; label: string; type?: 'text' | 'email' | 'tel' | 'number'; required?: boolean; placeholder?: string; nullable?: boolean }
export interface CrudColumn<T> { label: string; render: (row: T) => ReactNode }

interface Props<T extends { id: string }> {
  title: string;
  path: string;
  fields: CrudField<T>[];
  columns: CrudColumn<T>[];
  entity: string;
}

/** Generic list + create/edit/delete page for flat resources (warehouses, suppliers, customers). */
export function CrudPage<T extends { id: string }>({ title, path, fields, columns, entity }: Props<T>) {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const list = useApi<T[]>(`${path}${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  const [editing, setEditing] = useState<T | 'new' | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const action = useAction();
  const canWrite = can('staff');

  const open = (row: T | 'new') => {
    setEditing(row);
    setValues(Object.fromEntries(fields.map((f) => [f.key, row === 'new' ? '' : String((row as Record<string, unknown>)[f.key] ?? '')])));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = Object.fromEntries(fields.flatMap((f): [string, unknown][] => {
      const v = values[f.key]?.trim();
      if (f.type === 'number') return v ? [[f.key, Number(v)]] : []; // numbers are sent as numbers, and left out when blank (the server keeps its default)
      return [[f.key, v ? v : f.nullable ? null : '']];
    }));
    const ok = await action.run(() => editing === 'new' || !editing
      ? api(path, { body })
      : api(`${path}/${editing.id}`, { method: 'PATCH', body }));
    if (ok) { setEditing(null); list.reload(); }
  };

  const remove = async (row: T) => {
    if (!window.confirm(`Delete this ${entity}?`)) return;
    await action.run(() => api(`${path}/${row.id}`, { method: 'DELETE' }));
    list.reload();
  };

  return (
    <Page title={title} actions={canWrite && <button className="primary" onClick={() => open('new')}>+ New {entity}</button>}>
      <ErrorBanner error={list.error ?? action.error} />
      {editing && (
        <form className="card grid" onSubmit={submit} aria-label={`${entity} form`}>
          <h2>{editing === 'new' ? `New ${entity}` : `Edit ${entity}`}</h2>
          <div className="form-grid">
            {fields.map((f) => (
              <Field key={f.key} label={f.label}>
                <input type={f.type ?? 'text'} required={f.required} placeholder={f.placeholder} value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
              </Field>
            ))}
          </div>
          <div className="row">
            <button className="primary" type="submit" disabled={action.busy}>Save</button>
            <button type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}
      <Card>
        <input type="search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320, marginBottom: 12 }} aria-label={`Search ${title}`} />
        {list.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr>{columns.map((c) => <th key={c.label}>{c.label}</th>)}<th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.data.map((row) => (
                  <tr key={row.id}>
                    {columns.map((c) => <td key={c.label}>{c.render(row)}</td>)}
                    <td className="num">{canWrite && (
                      <span className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="small" onClick={() => open(row)}>Edit</button>
                        <button className="small danger" onClick={() => void remove(row)}>Delete</button>
                      </span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{list.loading ? 'Loading…' : `No ${title.toLowerCase()} yet.`}</Empty>}
      </Card>
    </Page>
  );
}
