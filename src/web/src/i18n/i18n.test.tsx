import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { en, type Key } from './en';
import { hi } from './hi';
import { I18nProvider, LanguageSwitch, localeOf, translate, useT } from '.';
import { Login } from '../pages/Login';
import { Shop } from '../pages/Shop';
import { AuthProvider } from '../auth';
import { dateTime, money, setFormatLocale } from '../format';
import { mockApi } from '../test/setup';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
afterEach(() => { setFormatLocale(undefined); document.documentElement.lang = 'en'; });

describe('catalogs', () => {
  it('Hindi has exactly the keys English has, none empty, with the same placeholders, and is really Hindi', () => {
    const keys = Object.keys(en) as Key[];
    expect(Object.keys(hi).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      expect(hi[k].trim(), k).not.toBe('');
      expect(placeholders(hi[k]), `placeholders of ${k}`).toEqual(placeholders(en[k]));
      if (!['lang.label'].includes(k)) expect(/[ऀ-ॿ]/.test(hi[k]), `${k} should contain Devanagari`).toBe(true);
    }
  });

  it('fills placeholders and falls back to English text for an unknown language key', () => {
    expect(translate('hi', 'shop.inStock', { n: 4 })).toBe('4 स्टॉक में');
    expect(translate('en', 'shop.inStock', { n: 4 })).toBe('4 in stock');
    expect(translate('en', 'shop.inStock')).toContain('{n}');
  });
});

describe('formatting follows the language', () => {
  it('uses Indian digit grouping and month names in the chosen language, digits stay 0-9', () => {
    setFormatLocale(localeOf('en'));
    expect(money(12345600, 'INR')).toBe('₹1,23,456.00');
    expect(dateTime('2026-03-05T10:00:00Z')).toMatch(/Mar/);
    setFormatLocale(localeOf('hi'));
    expect(money(12345600, 'INR')).toBe('₹1,23,456.00');
    expect(dateTime('2026-03-05T10:00:00Z')).toMatch(/मार्च/);
    expect(localeOf('hi')).toBe('hi-IN');
  });
});

describe('the language switch', () => {
  function Probe() { const { t, lang } = useT(); return <p data-testid="p">{lang}:{t('shell.signOut')}</p>; }

  it('changes every string at once, remembers the choice, sets the page language and tells the server for signed-in users', () => {
    localStorage.clear();
    const saved = vi.fn();
    render(<I18nProvider onChange={saved}><LanguageSwitch /><Probe /></I18nProvider>);
    expect(screen.getByTestId('p')).toHaveTextContent('en:Sign out');
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'hi' } });
    expect(screen.getByTestId('p')).toHaveTextContent('hi:साइन आउट');
    expect(document.documentElement.lang).toBe('hi');
    expect(localStorage.getItem('stocksync.lang')).toBe('hi');
    expect(saved).toHaveBeenCalledWith('hi');
    expect(screen.getByLabelText('भाषा')).toBeInTheDocument();                       // the control itself is translated
  });

  it('a signed-in user\'s saved language wins over the browser\'s', () => {
    localStorage.setItem('stocksync.lang', 'en');
    render(<I18nProvider preferred="hi"><Probe /></I18nProvider>);
    expect(screen.getByTestId('p')).toHaveTextContent('hi:साइन आउट');
  });

  it('without any provider, screens stay in English (so every existing page works as before)', () => {
    render(<Probe />);
    expect(screen.getByTestId('p')).toHaveTextContent('en:Sign out');
  });
});

describe('screens in Hindi', () => {
  it('the sign-in page', () => {
    localStorage.setItem('stocksync.lang', 'hi');
    mockApi({});
    render(<AuthProvider><I18nProvider><MemoryRouter><Routes><Route path="*" element={<Login />} /></Routes></MemoryRouter></I18nProvider></AuthProvider>);
    expect(screen.getByLabelText('ईमेल')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'साइन इन' })).toBeInTheDocument();
    expect(screen.getByText('नए हैं? व्यापार खाता बनाएँ')).toBeInTheDocument();
    localStorage.clear();
  });

  it('the storefront: products, cart and checkout wording', async () => {
    localStorage.setItem('stocksync.lang', 'hi'); localStorage.removeItem('stocksync.cart');
    mockApi({ '/public/catalog': { settings: { businessName: 'कोना दुकान', currency: 'INR', whatsappNumber: '', paymentMethods: ['COD'] },
      products: [{ id: 'p1', sku: 'TEE', name: 'टी-शर्ट', description: '', priceCents: 49900, unit: 'pcs', imageUrl: null, attributes: {}, categoryId: null, inStock: true, available: 7 }] } });
    render(<I18nProvider><MemoryRouter><Routes><Route path="*" element={<Shop />} /></Routes></MemoryRouter></I18nProvider>);
    expect(await screen.findByText('7 स्टॉक में')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'टी-शर्ट कार्ट में जोड़ें' }));
    expect(await screen.findByText('आपका कार्ट')).toBeInTheDocument();
    expect(screen.getByText('💵 डिलीवरी पर नकद भुगतान करें।')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ऑर्डर करें' })).toBeInTheDocument();
    expect(screen.getByLabelText('उत्पाद खोजें')).toBeInTheDocument();
    localStorage.clear();
  });
});
