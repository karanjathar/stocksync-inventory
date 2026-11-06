import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, errorText } from '../api/client';
import { money, whatsappLink } from '../format';
import { Badge, Empty, ErrorBanner, Field } from '../components/ui';
import { isSafePaymentUrl, redirectTo } from '../redirect';
import type { CartQuote, PaymentMethod, PlacedOrder, PublicCatalog, PublicOrderStatus, PublicProduct } from '../api/types';

const CART_KEY = 'stocksync.cart';
const LAST_ONLINE_KEY = 'stocksync.lastOnlineOrder'; // the shopper may back out of the payment page; let them resume
type Cart = Record<string, number>;

function loadCart(): Cart {
  try { return JSON.parse(localStorage.getItem(CART_KEY) ?? '{}') as Cart; } catch { return {}; }
}

function readLastOnline(): { token: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_ONLINE_KEY) ?? 'null') as { token?: unknown } | null;
    return v && typeof v.token === 'string' ? { token: v.token } : null;
  } catch { return null; }
}
const forgetLastOnline = () => { try { localStorage.removeItem(LAST_ONLINE_KEY); } catch { /* ignore */ } };

/** Public storefront: browse, cart, checkout on the website or hand the cart to WhatsApp. */
export function Shop() {
  const [catalog, setCatalog] = useState<PublicCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<Cart>(loadCart);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<PaymentMethod | null>(null);
  const navigate = useNavigate();
  const [resume, setResume] = useState<{ token: string; number: number } | null>(null);

  useEffect(() => {
    api<PublicCatalog>('/public/catalog').then(setCatalog, (e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    const last = readLastOnline();
    if (!last) return;
    api<PublicOrderStatus>(`/public/orders/${encodeURIComponent(last.token)}`).then((o) => {
      if (o.paymentMethod === 'ONLINE' && o.paymentStatus === 'UNPAID' && o.status !== 'CANCELLED') setResume({ token: last.token, number: o.number });
      else forgetLastOnline(); // paid or cancelled: nothing left to resume
    }, (err: unknown) => {
      if (err instanceof ApiError && err.status === 404) forgetLastOnline(); // unknown order; other errors are temporary
    });
  }, []);
  useEffect(() => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* ignore */ }
  }, [cart]);
  useEffect(() => { if (catalog) document.title = catalog.settings.businessName; }, [catalog]);

  const byId = useMemo(() => new Map(catalog?.products.map((p) => [p.id, p]) ?? []), [catalog]);
  const lines = Object.entries(cart)
    .map(([id, qty]) => ({ product: byId.get(id), qty }))
    .filter((l): l is { product: PublicProduct; qty: number } => Boolean(l.product) && l.qty > 0);
  const localTotal = lines.reduce((sum, l) => sum + l.product.priceCents * l.qty, 0);
  // The real payable total comes from the server (tax and discounts are computed there only); the local sum is the fallback.
  const [quote, setQuote] = useState<CartQuote | null>(null);
  const quoteKey = lines.map((l) => `${l.product.id}:${l.qty}`).join(',');
  useEffect(() => {
    if (!quoteKey) { setQuote(null); return; }
    const ac = new AbortController();
    const items = quoteKey.split(',').map((p) => { const [productId, qty] = p.split(':'); return { productId, quantity: Number(qty) }; });
    api<CartQuote>('/public/quote', { body: { items }, signal: ac.signal }).then(setQuote, () => { if (!ac.signal.aborted) setQuote(null); });
    return () => ac.abort();
  }, [quoteKey]);
  const total = quote?.totalCents ?? localTotal;
  const currency = catalog?.settings.currency ?? 'USD';
  const visible = (catalog?.products ?? []).filter((p) => {
    const q = search.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
  }).sort((a, b) => Number(b.inStock) - Number(a.inStock));
  const itemCount = lines.reduce((n, l) => n + l.qty, 0);

  const add = (p: PublicProduct, delta = 1) => setCart((c) => {
    const next = Math.max(0, Math.min(p.available, (c[p.id] ?? 0) + delta));
    const copy = { ...c };
    if (next === 0) delete copy[p.id]; else copy[p.id] = next;
    return copy;
  });

  const methods = catalog?.settings.paymentMethods ?? [];
  const method = chosen && methods.includes(chosen) ? chosen : methods[0];

  const waText = catalog
    ? [`Hi ${catalog.settings.businessName}! I'd like to order:`, ...lines.map((l) => `order ${l.product.sku} ${l.qty}`)].join('\n')
    : '';

  const checkout = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<PlacedOrder>('/public/orders', {
        body: { name: name.trim(), phone: phone.trim(), paymentMethod: method, items: lines.map((l) => ({ productId: l.product.id, quantity: l.qty })) },
      });
      setCart({}); // the order exists now; the cart is only emptied after the server accepted it
      if (res.paymentMethod === 'ONLINE') {
        try { localStorage.setItem(LAST_ONLINE_KEY, JSON.stringify({ token: res.token })); } catch { /* storage unavailable */ }
      }
      if (res.paymentUrl && isSafePaymentUrl(res.paymentUrl)) redirectTo(res.paymentUrl);
      else navigate(`/shop/order/${res.token}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <header className="shop-head">
        <h1 style={{ fontSize: 'clamp(1.1rem, 4vw, 1.5rem)' }}>{catalog?.settings.businessName ?? 'Shop'}</h1>
        <div className="spacer" />
        <input type="search" aria-label="Search products" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} />
        <button className="primary" aria-label={`View cart (${itemCount} items)`} onClick={() => document.getElementById('cart')?.scrollIntoView({ behavior: 'smooth' })}>🛒 {itemCount}</button>
      </header>
      <div className="shop-layout">
        <div className="grid">
          <ErrorBanner error={error} />
          {resume && (
            <div className="banner ok">
              ⏳ You have an unpaid order. <Link to={`/shop/order/${resume.token}`}>Continue payment for order #{resume.number}</Link>
            </div>
          )}
          {catalog && !visible.length && <Empty>No products found.</Empty>}
          <div className="shop-grid">
            {visible.map((p) => (
              <article key={p.id} className="card product-card">
                {p.imageUrl ? <img src={p.imageUrl} alt={p.name} loading="lazy" /> : <div className="ph" aria-hidden>📦</div>}
                <h3 style={{ margin: 0 }}>{p.name}</h3>
                {p.description && <p className="muted small" style={{ margin: 0 }}>{p.description}</p>}
                <div className="attrs">{Object.entries(p.attributes).map(([k, v]) => <Badge key={k}>{k}: {v}</Badge>)}</div>
                <div className="row">
                  <span className="price">{money(p.priceCents, currency)}</span>
                  <span className="spacer" />
                  {p.inStock ? <Badge tone="good">{p.available} in stock</Badge> : <Badge tone="bad">Out of stock</Badge>}
                </div>
                <button className="primary" aria-label={`Add ${p.name} to cart`} disabled={!p.inStock || (cart[p.id] ?? 0) >= p.available} onClick={() => add(p)}>
                  Add to cart
                </button>
              </article>
            ))}
          </div>
        </div>
        <aside id="cart" className="card cart" role="region" aria-label="Cart">
          <h2>Your cart</h2>
          {lines.length ? (
            <>
              <ul className="feed">
                {lines.map((l) => (
                  <li key={l.product.id}>
                    <span style={{ flex: 1 }}>{l.qty} × {l.product.name}</span>
                    <button className="small" aria-label={`Remove one ${l.product.name}`} onClick={() => add(l.product, -1)}>−</button>
                    <span>{money(l.product.priceCents * l.qty, currency)}</span>
                  </li>
                ))}
              </ul>
              {quote && quote.taxCents > 0 && (
                <div className="muted small" style={{ marginTop: 8 }}>
                  {quote.inclusive
                    ? <div>Includes tax {money(quote.taxCents, currency)}</div>
                    : <><div>Subtotal {money(quote.subtotalCents, currency)}</div><div>Tax {money(quote.taxCents, currency)}</div></>}
                </div>
              )}
              <div className="row" style={{ margin: '12px 0' }}><strong>Total</strong><span className="spacer" /><strong>{money(total, currency)}</strong></div>
              <form className="grid" onSubmit={checkout} style={{ gap: 10 }}>
                <Field label="Your name"><input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
                <Field label="Phone (WhatsApp)"><input required type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="+15551234567" /></Field>
                {methods.length > 1 ? (
                  <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend>Payment</legend>
                    {methods.map((m) => (
                      <label key={m} className="row small" style={{ margin: '4px 0' }}>
                        <input type="radio" name="payment" style={{ width: 'auto' }} checked={method === m} onChange={() => setChosen(m)} />
                        {m === 'ONLINE' ? 'Pay online (UPI / cards)' : 'Cash on delivery'}
                      </label>
                    ))}
                  </fieldset>
                ) : methods.length === 1 ? (
                  <p className="small muted">{method === 'ONLINE' ? '💳 You will pay online (UPI / cards).' : '💵 Pay cash on delivery.'}</p>
                ) : (
                  <p className="banner error">Ordering is temporarily unavailable. Please try again later{catalog?.settings.whatsappNumber ? ' or order on WhatsApp' : ''}.</p>
                )}
                <button className="primary" type="submit" disabled={busy || !method}>Place order</button>
              </form>
              {catalog?.settings.whatsappNumber && (
                <p style={{ textAlign: 'center' }}>
                  <a href={whatsappLink(catalog.settings.whatsappNumber, waText)} target="_blank" rel="noreferrer">💬 Or order on WhatsApp</a>
                </p>
              )}
            </>
          ) : <Empty>Your cart is empty.</Empty>}
        </aside>
      </div>
    </div>
  );
}
