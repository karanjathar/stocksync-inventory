import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, ApiError, errorText } from '../api/client';
import { money } from '../format';
import { isSafePaymentUrl } from '../redirect';
import { Badge, Card, ErrorBanner } from '../components/ui';
import type { PublicOrderStatus } from '../api/types';

const POLL_MS = 3000;
const GIVE_UP_MS = 2 * 60_000;

const waiting = (o: PublicOrderStatus) => o.paymentMethod === 'ONLINE' && o.paymentStatus === 'UNPAID' && o.status !== 'CANCELLED';

/** Public order page (/shop/order/:token): shows live status and keeps polling while an online payment is pending. */
export function ShopOrder() {
  const { token = '' } = useParams();
  const [search] = useSearchParams();
  const [order, setOrder] = useState<PublicOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  // The redirect query is only a hint for the wording — payment state always comes from the server (webhook).
  const redirectedAsPaid = search.get('razorpay_payment_link_status') === 'paid';

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const load = async () => {
      let again = false;
      try {
        const o = await api<PublicOrderStatus>(`/public/orders/${encodeURIComponent(token)}`);
        if (stopped) return;
        setOrder(o);
        setError(null);
        again = waiting(o);
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && err.status === 404) { setNotFound(true); return; }
        setError(errorText(err));
        again = true; // transient failure: keep trying within the time limit
      }
      if (!again) return;
      if (Date.now() - started >= GIVE_UP_MS) { setGaveUp(true); return; }
      timer = setTimeout(() => { void load(); }, POLL_MS);
    };
    void load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [token]);

  if (notFound) {
    return <Shell><Card><p>We couldn't find that order. Check the link you were given, or <Link to="/shop">go back to the shop</Link>.</p></Card></Shell>;
  }
  if (!order) return <Shell>{error ? <ErrorBanner error={error} /> : <p className="muted">Loading your order…</p>}</Shell>;

  const total = money(order.totalCents, order.currency);
  const payUrl = isSafePaymentUrl(order.paymentUrl) ? order.paymentUrl : undefined;
  return (
    <Shell>
      <Card>
        <div className="row">
          <h1 style={{ fontSize: '1.4rem' }}>Order #{order.number}</h1>
          <span className="spacer" />
          <Badge tone={order.status === 'CANCELLED' ? 'bad' : order.paymentStatus === 'PAID' ? 'good' : 'warn'}>{order.status.toLowerCase()}</Badge>
        </div>
        <ErrorBanner error={error} />
        <Message order={order} gaveUp={gaveUp} redirectedAsPaid={redirectedAsPaid} />
        {payUrl && waiting(order) && (
          <p><a className="primary" role="link" href={payUrl} style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 8, textDecoration: 'none' }}>💳 Pay {total} now</a></p>
        )}
        <ul className="feed">
          {order.items.map((i) => <li key={i.name}>{i.quantity} × {i.name}</li>)}
        </ul>
        <div className="row"><strong>Total</strong><span className="spacer" /><strong>{total}</strong></div>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header className="shop-head"><h1 style={{ fontSize: 'clamp(1.1rem, 4vw, 1.5rem)' }}>Your order</h1><span className="spacer" /><Link to="/shop">← Back to shop</Link></header>
      <div className="shop-layout" style={{ gridTemplateColumns: '1fr', maxWidth: 640 }}><div className="grid">{children}</div></div>
    </div>
  );
}

function Message({ order, gaveUp, redirectedAsPaid }: { order: PublicOrderStatus; gaveUp: boolean; redirectedAsPaid: boolean }) {
  if (order.status === 'CANCELLED') {
    return <div className="banner error">This order was cancelled.{order.paymentStatus === 'REFUND_DUE' ? ' Your payment will be refunded.' : ''}</div>;
  }
  if (order.paymentStatus === 'REFUND_DUE') {
    return <div className="banner error">We received your payment but couldn't complete the order. A refund is on its way — sorry for the trouble.</div>;
  }
  if (order.paymentStatus === 'PAID') {
    return order.status === 'PENDING'
      ? <div className="banner ok">✅ Payment received. We'll confirm your order shortly.</div>
      : <div className="banner ok">✅ Payment received — your order is {order.status === 'FULFILLED' ? 'fulfilled' : 'confirmed'}. Thank you!</div>;
  }
  if (order.paymentMethod === 'ONLINE') {
    if (redirectedAsPaid && !gaveUp) return <p>⏳ Confirming your payment with the bank… this usually takes a few seconds.</p>;
    if (gaveUp) return <div className="banner error">We're still waiting for the payment confirmation. If you've already paid, we'll message you once it arrives — otherwise you can pay below.</div>;
    return <p>⏳ Waiting for payment…</p>;
  }
  return (
    <div className="banner ok">
      ✅ Order placed. Pay cash on delivery.{' '}
      {order.status === 'PENDING' ? "We'll confirm it shortly." : order.status === 'FULFILLED' ? 'It has been fulfilled.' : "It's confirmed and being prepared."}
    </div>
  );
}
