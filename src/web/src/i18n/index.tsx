import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type Key } from './en';
import { hi } from './hi';
import { setFormatLocale } from '../format';

export type Lang = 'en' | 'hi';
export const LANG_LABELS: Record<Lang, string> = { en: 'English', hi: 'हिन्दी' };
const catalogs: Record<Lang, Record<Key, string>> = { en, hi };
const STORAGE_KEY = 'stocksync.lang'; // a display preference, not a secret

export function translate(lang: Lang, key: Key, params: Record<string, string | number> = {}): string {
  return (catalogs[lang][key] ?? en[key]).replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Numbers, money and dates follow the language: Indian digit grouping (₹1,23,456) for both, month names in the chosen language. Digits stay 0–9, as on Indian price tags. */
export const localeOf = (lang: Lang): string => (lang === 'hi' ? 'hi-IN' : 'en-IN');

interface I18n { lang: Lang; setLang(l: Lang): void; t(key: Key, params?: Record<string, string | number>): string; locale: string }
const Ctx = createContext<I18n>({ lang: 'en', setLang: () => undefined, t: (k, p) => translate('en', k, p), locale: localeOf('en') });
export const useT = (): I18n => useContext(Ctx);

function initialLang(): Lang {
  try { const saved = localStorage.getItem(STORAGE_KEY); if (saved === 'en' || saved === 'hi') return saved; } catch { /* storage unavailable */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('hi') ? 'hi' : 'en';
}

/** `preferred` is the signed-in user's saved language (it wins once known); `onChange` saves a new choice for them. */
export function I18nProvider({ preferred, onChange, children }: { preferred?: Lang | null; onChange?: (l: Lang) => void; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => { if (preferred) setLangState(preferred); }, [preferred]);
  useEffect(() => { if (typeof document !== 'undefined') document.documentElement.lang = lang; setFormatLocale(localeOf(lang)); }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
    onChange?.(l);
  }, [onChange]);
  const value = useMemo<I18n>(() => ({ lang, setLang, t: (k, p) => translate(lang, k, p), locale: localeOf(lang) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** A plain select (works with keyboard and screen readers) that changes the language everywhere. */
export function LanguageSwitch() {
  const { lang, setLang, t } = useT();
  return (
    <label className="small">
      <span className="sr-only">{t('lang.label')}</span>
      <select aria-label={t('lang.label')} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
        {(Object.keys(LANG_LABELS) as Lang[]).map((l) => <option key={l} value={l} lang={l}>{LANG_LABELS[l]}</option>)}
      </select>
    </label>
  );
}
