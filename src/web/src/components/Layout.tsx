import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth';
import { useSettings } from '../settings';
import type { Role } from '../api/types';
import { LanguageSwitch, useT } from '../i18n';
import type { Key } from '../i18n/en';

const NAV: { to: string; label: Key; icon: string; role: Role }[] = [
  { to: '/', label: 'nav.dashboard', icon: '📊', role: 'viewer' },
  { to: '/products', label: 'nav.products', icon: '🏷️', role: 'viewer' },
  { to: '/inventory', label: 'nav.inventory', icon: '📦', role: 'viewer' },
  { to: '/stock-counts', label: 'nav.stockCounts', icon: '📋', role: 'viewer' },
  { to: '/movements', label: 'nav.movements', icon: '🔁', role: 'viewer' },
  { to: '/orders', label: 'nav.orders', icon: '🧾', role: 'viewer' },
  { to: '/purchase-orders', label: 'nav.purchasing', icon: '🛒', role: 'viewer' },
  { to: '/inbox', label: 'nav.inbox', icon: '💬', role: 'staff' },
  { to: '/customers', label: 'nav.customers', icon: '👥', role: 'viewer' },
  { to: '/suppliers', label: 'nav.suppliers', icon: '🚚', role: 'viewer' },
  { to: '/warehouses', label: 'nav.warehouses', icon: '🏬', role: 'viewer' },
  { to: '/settings', label: 'nav.settings', icon: '⚙️', role: 'admin' },
  { to: '/users', label: 'nav.users', icon: '🔐', role: 'admin' },
  { to: '/analytics', label: 'nav.analytics', icon: '📈', role: 'staff' },
  { to: '/assistant', label: 'nav.assistant', icon: '✨', role: 'viewer' },
  { to: '/activity', label: 'nav.activity', icon: '🧾', role: 'admin' },
  { to: '/usage', label: 'nav.usage', icon: '📊', role: 'admin' },
];

export function Layout() {
  const { user, logout, can } = useAuth();
  const { settings } = useSettings();
  const { t } = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <a className="skip-link" href="#main">{t('shell.skip')}</a>
      <aside className="sidebar" id="sidebar-nav">
        <div className="brand">📦 {settings.businessName}</div>
        <nav aria-label={t('shell.mainNav')} onClick={() => setOpen(false)}>
          {NAV.filter((n) => can(n.role)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              <span aria-hidden>{n.icon}</span> {t(n.label)}
            </NavLink>
          ))}
          <a href="/shop" target="_blank" rel="noreferrer"><span aria-hidden>🛍️</span> {t('nav.publicShop')}</a>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="ghost menu" aria-label={t('shell.toggleMenu')} aria-expanded={open} aria-controls="sidebar-nav" onClick={() => setOpen((o) => !o)}>☰</button>
          <div className="spacer" />
          <LanguageSwitch />
          <NavLink className="muted small" to="/account">{user?.name} · {user?.role}</NavLink>
          <button className="ghost" onClick={logout}>{t('shell.signOut')}</button>
        </header>
        <main id="main" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}
