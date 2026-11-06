import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth';
import { SettingsProvider } from './settings';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Products } from './pages/Products';
import { Inventory } from './pages/Inventory';
import { Movements } from './pages/Movements';
import { Customers, Suppliers, Warehouses } from './pages/Parties';
import { Orders } from './pages/Orders';
import { PurchaseOrders } from './pages/PurchaseOrders';
import { Bills } from './pages/Bills';
import { Reorder } from './pages/Reorder';
import { Inbox } from './pages/Inbox';
import { SettingsPage } from './pages/SettingsPage';
import { Users } from './pages/Users';
import { Shop } from './pages/Shop';
import { ShopOrder } from './pages/ShopOrder';
import { Account } from './pages/Account';
import type { Role } from './api/types';

function RequireAuth({ children, role = 'viewer' }: { children: ReactNode; role?: Role }) {
  const { user, ready, can } = useAuth();
  const location = useLocation();
  if (!ready) return <div className="center muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!can(role)) return <div className="center">You do not have access to this page.</div>;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/shop" element={<Shop />} />
      <Route path="/shop/order/:token" element={<ShopOrder />} />
      <Route element={<RequireAuth><SettingsProvider><Layout /></SettingsProvider></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="products" element={<Products />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="movements" element={<Movements />} />
        <Route path="warehouses" element={<Warehouses />} />
        <Route path="suppliers" element={<Suppliers />} />
        <Route path="customers" element={<Customers />} />
        <Route path="orders" element={<Orders />} />
        <Route path="purchase-orders" element={<PurchaseOrders />} />
        <Route path="bills" element={<Bills />} />
        <Route path="reorder" element={<Reorder />} />
        <Route path="inbox" element={<RequireAuth role="staff"><Inbox /></RequireAuth>} />
        <Route path="account" element={<Account />} />
        <Route path="settings" element={<RequireAuth role="admin"><SettingsPage /></RequireAuth>} />
        <Route path="users" element={<RequireAuth role="admin"><Users /></RequireAuth>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
