/** Full-page navigation to an external payment page (a seam so tests can observe it). */
export function redirectTo(url: string): void {
  window.location.assign(url);
}

/**
 * Payment URLs come from our own API, but a page that navigates the browser must still never follow
 * a `javascript:` / `data:` URL: allow https, and plain http only for localhost (the E2E fake Razorpay).
 */
export function isSafePaymentUrl(value: string | undefined | null): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}
