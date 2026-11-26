import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { useAuth } from './auth';
import { SettingsProvider } from './settings';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import type { Role } from './api/types';

// Route-level code splitting: a shopper never downloads the administration screens, and the shell loads before any page does.
const page = <T extends Record<string, unknown>, K extends keyof T>(load: () => Promise<T>, name: K) => lazy(async () => ({ default: (await load())[name] as ComponentType }));
const Dashboard = page(() => import('./pages/Dashboard'), 'Dashboard');
const Products = page(() => import('./pages/Products'), 'Products');
const Inventory = page(() => import('./pages/Inventory'), 'Inventory');
const Movements = page(() => import('./pages/Movements'), 'Movements');
const StockCounts = page(() => import('./pages/StockCounts'), 'StockCounts');
const Orders = page(() => import('./pages/Orders'), 'Orders');
const PurchaseOrders = page(() => import('./pages/PurchaseOrders'), 'PurchaseOrders');
const Inbox = page(() => import('./pages/Inbox'), 'Inbox');
const SettingsPage = page(() => import('./pages/SettingsPage'), 'SettingsPage');
const Users = page(() => import('./pages/Users'), 'Users');
const Shop = page(() => import('./pages/Shop'), 'Shop');
const ShopOrder = page(() => import('./pages/ShopOrder'), 'ShopOrder');
const Account = page(() => import('./pages/Account'), 'Account');
const Usage = page(() => import('./pages/Usage'), 'Usage');
const Assistant = page(() => import('./pages/Assistant'), 'Assistant');
const Analytics = page(() => import('./pages/Analytics'), 'Analytics');
const AuditLog = page(() => import('./pages/AuditLog'), 'AuditLog');
const Platform = page(() => import('./pages/Platform'), 'Platform');
const Customers = page(() => import('./pages/Parties'), 'Customers');
const Suppliers = page(() => import('./pages/Parties'), 'Suppliers');
const Warehouses = page(() => import('./pages/Parties'), 'Warehouses');
const Signup = page(() => import('./pages/Signup'), 'Signup');
const VerifyEmail = page(() => import('./pages/Signup'), 'VerifyEmail');

function RequireAuth({ children, role = 'viewer' }: { children: ReactNode; role?: Role }) {
  const { user, ready, can } = useAuth();
  const location = useLocation();
  if (!ready) return <div className="center muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!can(role)) return <div className="center">You do not have access to this page.</div>;
  return <>{children}</>;
}

/** One business's shop; remounts when the slug changes so a cart never leaks from one business's shop into another's. */
function ShopBySlug() {
  const { slug } = useParams();
  return <Shop key={slug} />;
}

export function App() {
  return (
    <Suspense fallback={<div className="center muted" role="status">Loading…</div>}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/platform" element={<Platform />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/shop" element={<Shop />} />
      <Route path="/shop/order/:token" element={<ShopOrder />} />
      <Route path="/shop/:slug" element={<ShopBySlug />} />
      <Route element={<RequireAuth><SettingsProvider><Layout /></SettingsProvider></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="products" element={<Products />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="movements" element={<Movements />} />
        <Route path="stock-counts" element={<StockCounts />} />
        <Route path="warehouses" element={<Warehouses />} />
        <Route path="suppliers" element={<Suppliers />} />
        <Route path="customers" element={<Customers />} />
        <Route path="orders" element={<Orders />} />
        <Route path="purchase-orders" element={<PurchaseOrders />} />
        <Route path="inbox" element={<RequireAuth role="staff"><Inbox /></RequireAuth>} />
        <Route path="account" element={<Account />} />
        <Route path="settings" element={<RequireAuth role="admin"><SettingsPage /></RequireAuth>} />
        <Route path="users" element={<RequireAuth role="admin"><Users /></RequireAuth>} />
        <Route path="activity" element={<RequireAuth role="admin"><AuditLog /></RequireAuth>} />
        <Route path="analytics" element={<RequireAuth role="staff"><Analytics /></RequireAuth>} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="usage" element={<RequireAuth role="admin"><Usage /></RequireAuth>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
