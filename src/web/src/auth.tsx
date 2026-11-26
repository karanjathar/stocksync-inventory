import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, AUTH_EXPIRED_EVENT, hasSessionHint, markSignedIn } from './api/client';
import type { Role, User } from './api/types';

const RANK: Record<Role, number> = { viewer: 1, staff: 2, admin: 3 };

interface AuthState {
  user: User | null;
  ready: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): void;
  /** Ends this user's sessions on every device. */
  logoutEverywhere(): Promise<void>;
  /** True when the signed-in user has at least this role. */
  can(role: Role): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // The session is a cookie: ask the server who we are (it refreshes the cookie itself when needed), but only if there is one.
    if (!hasSessionHint()) { setReady(true); return; }
    api<User>('/auth/me').then((u) => { markSignedIn(true); setUser(u); }, () => markSignedIn(false)).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<{ user: User }>('/auth/login', { body: { email, password } }); // the response also carries a bearer token for API clients; the web app does not keep it
    markSignedIn(true);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    // The screen only changes once the server has ended the session and cleared the cookies (or could not be reached), never before.
    void api('/auth/logout', { method: 'POST' }).catch(() => undefined).finally(() => { markSignedIn(false); setUser(null); });
  }, []);
  const logoutEverywhere = useCallback(async () => { await api('/auth/logout-all', { method: 'POST' }); markSignedIn(false); setUser(null); }, []);
  const can = useCallback((role: Role) => (user ? RANK[user.role] >= RANK[role] : false), [user]);

  const value = useMemo(() => ({ user, ready, login, logout, logoutEverywhere, can }), [user, ready, login, logout, logoutEverywhere, can]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
