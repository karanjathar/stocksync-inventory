import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AuthProvider, useAuth } from './auth';
import { api } from './api/client';
import { I18nProvider, type Lang } from './i18n';
import { App } from './App';
import './styles.css';

/** The signed-in user's saved language (it follows them between devices); a change is saved for them. */
function Language({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return <I18nProvider preferred={user?.language} onChange={(l: Lang) => { if (user) void api('/auth/language', { method: 'PATCH', body: { language: l } }).catch(() => undefined); }}>{children}</I18nProvider>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <Language>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </Language>
    </AuthProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA install is optional */ });
  });
}
