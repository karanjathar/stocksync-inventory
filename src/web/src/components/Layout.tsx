import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth';
import { useSettings } from '../settings';
import type { Role } from '../api/types';

const NAV: { to: string; label: string; icon: string; role: Role }[] = [
  { to: '/', label: 'Dashboard', icon: '📊', role: 'viewer' },
  { to: '/products', label: 'Products', icon: '🏷️', role: 'viewer' },
  { to: '/inventory', label: 'Inventory', icon: '📦', role: 'viewer' },
  { to: '/movements', label: 'Movements', icon: '🔁', role: 'viewer' },
  { to: '/orders', label: 'Orders', icon: '🧾', role: 'viewer' },
  { to: '/purchase-orders', label: 'Purchase orders', icon: '📥', role: 'viewer' },
  { to: '/bills', label: 'Bills', icon: '💳', role: 'staff' },
  { to: '/reorder', label: 'Reorder', icon: '🔔', role: 'viewer' },
  { to: '/inbox', label: 'Inbox', icon: '💬', role: 'staff' },
  { to: '/customers', label: 'Customers', icon: '👥', role: 'viewer' },
  { to: '/suppliers', label: 'Suppliers', icon: '🚚', role: 'viewer' },
  { to: '/warehouses', label: 'Warehouses', icon: '🏬', role: 'viewer' },
  { to: '/settings', label: 'Settings', icon: '⚙️', role: 'admin' },
  { to: '/users', label: 'Users', icon: '🔐', role: 'admin' },
];

export function Layout() {
  const { user, logout, can } = useAuth();
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">📦 {settings.businessName}</div>
        <nav onClick={() => setOpen(false)}>
          {NAV.filter((n) => can(n.role)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              <span aria-hidden>{n.icon}</span> {n.label}
            </NavLink>
          ))}
          <a href="/shop" target="_blank" rel="noreferrer"><span aria-hidden>🛍️</span> Public shop</a>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="ghost menu" aria-label="Toggle menu" onClick={() => setOpen((o) => !o)}>☰</button>
          <div className="spacer" />
          <NavLink className="muted small" to="/account">{user?.name} · {user?.role}</NavLink>
          <button className="ghost" onClick={logout}>Sign out</button>
        </header>
        <main><Outlet /></main>
      </div>
    </div>
  );
}
