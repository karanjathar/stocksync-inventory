import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { dateTime } from '../format';
import { Card, ErrorBanner, Field, Page } from '../components/ui';
import type { Role, User } from '../api/types';

export function Users() {
  const { user: me } = useAuth();
  const users = useApi<User[]>('/users');
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'staff' as Role });
  const action = useAction();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(() => api('/users', { body: form }));
    if (ok) { setForm({ email: '', name: '', password: '', role: 'staff' }); users.reload(); }
  };
  const changeRole = async (u: User, role: Role) => {
    await action.run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { role } }));
    users.reload();
  };
  const remove = async (u: User) => {
    if (!window.confirm(`Remove ${u.email}?`)) return;
    await action.run(() => api(`/users/${u.id}`, { method: 'DELETE' }));
    users.reload();
  };

  return (
    <Page title="Users">
      <ErrorBanner error={users.error ?? action.error} />
      <form className="card grid" onSubmit={create} aria-label="Invite user">
        <h2>Add a team member</h2>
        <div className="form-grid">
          <Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Temporary password" hint="At least 8 characters"><input required minLength={8} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Role">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="viewer">viewer — read only</option><option value="staff">staff — manage stock & orders</option><option value="admin">admin — everything</option>
            </select>
          </Field>
        </div>
        <div><button className="primary" type="submit" disabled={action.busy}>Add user</button></div>
      </form>
      <Card>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td><td>{u.email}</td>
                <td>
                  <select aria-label={`Role for ${u.email}`} value={u.role} disabled={u.id === me?.id} onChange={(e) => void changeRole(u, e.target.value as Role)} style={{ width: 'auto' }}>
                    <option value="viewer">viewer</option><option value="staff">staff</option><option value="admin">admin</option>
                  </select>
                </td>
                <td className="small">{dateTime(u.createdAt)}</td>
                <td className="num">{u.id !== me?.id && <button className="small danger" onClick={() => void remove(u)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
