# 7. Security Audit — Pre-Deployment

**Date:** 2026-11-06 · **Scope:** `src/api`, `src/web`, dependencies, configuration · **Result:** ✅ PASSED (no open high/critical findings)

## 7.1 Automated checks
| Check | Command / method | Result |
|---|---|---|
| Type safety | `npm run typecheck` (strict TS, `noUncheckedIndexedAccess`) | ✅ 0 errors |
| `any` / suppressions | grep `any`, `as any`, `@ts-ignore`, `eslint-disable` + ESLint `no-explicit-any: error` | ✅ none |
| Hard-coded secrets | grep for password/secret/token/key literals in `src/` (non-test) | ✅ none. The only key in tests is Azurite's public, documented dev key |
| Dangerous sinks | grep `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `child_process` | ✅ none |
| SQL injection | Reviewed every interpolated query | ✅ All values are `$n` parameters. Interpolated fragments are static constants or whitelisted column maps |
| Dependencies (prod) | `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| Dependencies (dev) | `npm audit` | ✅ 0 after fix F-01 |
| Test suite | `npm test` | ✅ 99 API (real PostgreSQL) + 14 web tests |
| Browser E2E | Playwright against the production build | ✅ 0 console/CSP errors |

## 7.2 Controls verified
| Area | Control | Evidence |
|---|---|---|
| Secrets | All secrets come from env (Key Vault in Azure). `.env` is git-ignored and `.env.example` holds dummies. `JWT_SECRET` must be ≥ 32 chars or startup fails | `config/env.ts`, `env.test.ts` |
| AuthN | bcrypt (12 rounds) and HS256 JWT with pinned algorithm. Unknown emails take the same time as wrong passwords. Users are re-checked on every request, so deleted users lose access immediately | `services/auth.ts`, `auth.test.ts` |
| AuthZ | viewer < staff < admin RBAC on every mutating route. Admins cannot delete themselves | `middleware/auth.ts`, route tests (403 cases) |
| Input validation | zod on every body, query and route param. Malformed UUIDs → 404, constraint violations → 4xx | `http/validate.ts`, `params.ts`, `errors.ts` |
| Business integrity | Stock can never go negative (conditional UPDATE + CHECK constraint), ledger is append-only, consistent lock ordering prevents deadlocks | `services/stock.ts`, 25-way race test |
| Webhooks | Meta: timing-safe HMAC-SHA256 (`X-Hub-Signature-256`) over the raw body. Telegram: secret-token header. Both fail closed (503) when unconfigured and are idempotent on retries | `routes/webhooks.ts`, `webhooks.test.ts` |
| Chat privacy | The `status` command only reveals the sender's own orders. Inbox and live chat events are staff-only | `bot.test.ts`, `security.test.ts` |
| Rate limiting | API 600/min/IP, login 20/15 min, public orders 10/15 min, webhooks 1200/min | `app.ts`, `routes/*.ts` |
| HTTP hardening | helmet (CSP `default-src 'self'`, HSTS, nosniff, frameguard), `x-powered-by` off, 1 MB body limit, CORS allowlist (empty = same-origin only), `trust proxy` = 1 for Azure ingress | `http/app.ts`, `http.test.ts` |
| Error handling | Central handler. 500s return a generic message (no stack/internals). Unhandled rejections are logged | `errors.ts`, `http.test.ts` |
| Uploads | Browser uploads straight to Azure Blob with a 10-minute **write-only** SAS for a random blob name. Image MIME allowlist (no SVG, which blocks stored XSS) | `storage/blob.ts`, `public.test.ts` |
| Outbound calls | Fixed provider hosts only (no user-controlled URLs, so no SSRF), 10s timeouts, provider errors never echo tokens | `channels/*.ts`, `channels.test.ts` |
| Logging | Structured pino JSON. Request log records method, path, status, duration and user id only (no query strings, headers or bodies) | `middleware/requestLog.ts`, `security.test.ts` |
| Transport/DB | TLS to Azure PostgreSQL with certificate verification (`DATABASE_SSL=true`) | `db/pool.ts` |
| Container | Non-root user, multi-stage build, prod dependencies only (see Dockerfile) | Prompt 5 |

## 7.3 Findings & patches
| ID | Severity | Finding | Fix |
|---|---|---|---|
| F-01 | Moderate (dev only) | `minimatch` ReDoS advisory (GHSA-g3hv-75wg-m249) via `@typescript-eslint/typescript-estree` | npm `overrides` pins the patched `minimatch@^11.0.5`. Audit is clean and lint still passes |
| F-02 | Medium | No request/access logging (spec requires explicit logging) | Added `requestLog` middleware with a test proving tokens and query strings are not logged |
| F-03 | Medium | Viewers could read customer chat content (`GET /api/messages`, `message.received` SSE events) — personal data | Restricted to staff/admin on API, SSE and UI routes. Test added |
| F-04 | Medium | Bootstrap admin had no way to rotate its own password | Added `POST /api/auth/password` (current password required, rate-limited) and a "My account" page. Test added |
| F-05 | Low | Blank optional form fields were sent as `null` to NOT NULL columns. Postgres not-null violations returned 500 | Fixed in the UI. `23502` → 400 in the error handler (T21) |
| F-06 | Low | A missing static asset returned 500 | serve-static 404s now map to JSON 404 (T18) |

## 7.4 Accepted risks / recommendations
1. **JWT in `localStorage`.** This is readable by XSS. It's mitigated by a strict CSP (no inline scripts, no third-party scripts) and React output escaping. Move to httpOnly cookies + CSRF tokens if the threat model requires it.
2. **Single replica for realtime.** The SSE event bus is in-process. Scale out with Azure Web PubSub before raising `maxReplicas`.
3. **WhatsApp 24-hour window.** Free-form messages (alerts, order updates) only reach users who messaged the business in the last 24h. For guaranteed delivery, register Meta message templates. Staff can keep the window open by messaging the bot.
4. **Public stock counts.** `/api/public/catalog` shows exact availability. Cap or bucket the numbers if that's commercially sensitive.
5. **Viewers can see customer contact details** on the Customers page (an internal role, by design).
6. Rotate the `ADMIN_PASSWORD` bootstrap value after first login, and keep Key Vault soft-delete and purge protection enabled (set in Bicep).

---

# 7.R2 Release 2 Audit — Payments (Razorpay) & Interactive Chat

**Date:** 2026-11-06 · **Scope:** `src/api` payments, webhooks, chat flow, public checkout; `src/web` shop, order page, admin payment UI; `scripts/e2e`; dependencies · **Result:** ✅ PASSED once T56 and T57 are merged (no open High/Critical)
**Method:** phase-by-phase code review with reproduced defects (each fixed test-first), automated scans, a permanent security regression suite (`tests/securityPayments.test.ts`), mutation checks of that suite, and a browser E2E (`npm run e2e`).
**Not verified:** behaviour against the *real* Razorpay and Meta services (no credentials were available). Everything is verified against local fakes that follow the documented formats. A test-mode run with real keys remains on the release checklist.

## 7.R2.1 Automated checks
| Check | Result |
|---|---|
| `npm audit` (prod and dev) | ✅ 0 vulnerabilities |
| Secret-like literals added in Release 2 (source, docs, infra, CI) | ✅ none. Test and E2E secrets are dummies; `.env.example` holds placeholders only |
| Dangerous sinks (`innerHTML`, `eval`, shell, string-built SQL) in new code | ✅ none. The only interpolated SQL is a constant schema name inside a test |
| Type-check, lint (no `any` / suppressions), build | ✅ |
| Tests | ✅ API (real PostgreSQL) + web + security suite + E2E (28 checks) |
| **Mutation check of the security suite** | ✅ breaking the signature check, the order-ownership check, or the paid-amount check each makes the suite fail (1, 2 and 2 failing tests); restored afterwards |

## 7.R2.2 Attack classes tested (`tests/securityPayments.test.ts`)
| Class | What is proven |
|---|---|
| **Amount tampering** | Razorpay is always asked for the server-side order total (client-supplied `amount`, `totalCents`, unit prices ignored); staff cannot choose an amount; a webhook paying under or over the total never auto-confirms (→ `REFUND_DUE`, stock untouched); no API route can set a payment status |
| **Replay** | 5 simultaneous deliveries of one event settle once; the same signed body under new or missing event ids changes nothing (the `X-Razorpay-Event-Id` header is *not* signed, so state-based idempotency is the real defence); old `expired` / `cancelled` events cannot downgrade a paid payment |
| **Forged webhooks / callbacks** | Missing, empty, non-hex, wrong-secret, tampered-body, re-serialised-body and non-JSON deliveries are all 401. The redirect query (`razorpay_*`) is never trusted: forged "paid" callbacks change nothing (D-003) |
| **IDOR** | Order pages and "resume payment" are reachable only with the unguessable token (order numbers, other tokens, malformed ids → 404). Chat customers can't read, pay or detect other customers' orders: `status N`, `order:N`, `paylink:N` answer identically for "someone else's" and "doesn't exist". Carts are per customer. The same id on another channel is a different customer |
| **Transport headers** | Order pages: `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (the token can't leak to Razorpay), `nosniff`, `frame-ancestors 'self'` |

## 7.R2.3 Controls verified
| Area | Control | Evidence |
|---|---|---|
| Webhook authenticity | HMAC-SHA256 over the **raw** body, timing-safe compare; fails closed (503 if the secret is unset, 401 on mismatch) | `payments/razorpay.ts`, `routes/webhooks.ts`, R2-3 |
| Idempotency & recovery | Event-id claim (released on failure so retries run) + state-based settlement under row locks; the confirm step is resumable after a crash | `services/payments.ts`, `razorpayWebhook.test.ts` |
| Money integrity | Integer paise end to end; amount computed server-side; mismatch / cancelled / unfulfillable → `REFUND_DUE` + staff alert + customer notice; duplicate payments flagged; paid orders cancelled by staff flagged | T36, T47, T49, T50 |
| Link lifecycle | One open link per order (partial unique index + advisory lock); stale links cancelled; no database connection held during the Razorpay call; cancelled orders' links cancelled | T35, T48, T51 |
| Chat identity | Identity comes only from signature-verified webhooks (Meta HMAC, Telegram secret token); every action is scoped to the sender's own customer record | R2-4 |
| Public endpoints | Rate limited (orders 10/15 min, payment-link 30/15 min); tokens are UUIDv4 (122 bits); responses expose no PII or internal ids | R2-4 |
| Input handling | Action ids matched by strict regex; quantities capped by stock; list/button text clamped by `normaliseReply`; reflected user text bounded; zod on every request | `chatFlow.ts`, `reply.ts` |
| Front end | React escaping; payment URLs followed only if `https` (or loopback for E2E); `javascript:` URLs never rendered or followed | `redirect.ts`, `Shop.test.tsx`, `ShopOrder.test.tsx` |
| Secrets & logging | Razorpay secrets only from env / Key Vault; provider errors never contain credentials; request log has no bodies or query strings | `razorpay.test.ts`, `requestLog.ts` |
| CSRF | Not applicable to the API (bearer tokens, no cookies); the public JSON endpoints require `application/json` so a cross-site form post can't create orders | by design |

## 7.R2.4 Findings and fixes
All reproduced before fixing; every fix has a regression test.
| ID | Sev. | Finding | Fix |
|---|---|---|---|
| R2-01 | Medium | Emoji at a truncation boundary were split into a lone surrogate (WhatsApp can reject the message) | T44 |
| R2-02 | Medium | Two concurrent "Cash on delivery" taps created two orders from one cart | T46 (atomic cart take) |
| R2-03 | **High** | Cancelling a **paid** order restocked it but never flagged the refund | T47 |
| R2-04 | Medium | A cancelled order's payment link stayed payable | T48 |
| R2-05 | Medium | A second payment (customer paid two links) was silently accepted | T49 |
| R2-06 | Medium | Paid order with no default warehouse wrongly marked `REFUND_DUE` | T50 |
| R2-07 | Medium | Razorpay HTTP call held a pooled DB connection: a slow provider could freeze health checks and webhooks | T51 |
| R2-08 | Medium | A crash while auto-confirming a paid order left it stuck (the retry skipped the confirm step) | fixed inside T36 |
| R2-09 | Medium | Web shopper could not get a fresh payment link after expiry or abandonment | T52 |
| R2-10 | Low | The shop forgot an unpaid online order after the shopper backed out | T53 |
| R2-11 | Medium | A web shopper's typed phone number (with a guessed `+`) was sent to Razorpay as `customer.contact` | T54 (WhatsApp numbers only) |
| R2-12 | Low | Settings let an admin leave customers with no usable payment method | T55 (warning) |
| R2-13 | Low | `status <text>` reflected arbitrary typed text back unbounded | fixed in T42 (20 chars) |
| R2-14 | Low | Production config accepted a plain-`http` provider base URL (credentials in clear text) | T56 (production refuses non-https provider URLs; loopback allowed for the local E2E) |
| R2-15 | Medium | One chat or web customer could create unlimited open orders (40 in a probe) | **T57 — open until merged** |

## 7.R2.5 Accepted risks and recommendations
1. **Order links are bearer capabilities.** Anyone holding `/shop/order/<token>` can view that order's status and pay it. Mitigated by 122-bit tokens, no PII in the response, `no-store`, `no-referrer`, rate limits. Same model as hosted order pages elsewhere; shoppers should treat the link like a receipt.
2. **Stale unpaid online orders accumulate** (no automatic expiry; stock is only deducted on confirmation, so nothing is blocked). The T57 cap limits abuse. *Recommended next:* a scheduled job that cancels unpaid online orders older than N days.
3. **`webhook_events` grows without bound** (tiny rows). *Recommended:* delete rows older than 30 days (Razorpay retries for about a day).
4. **Do not change the shop currency after go-live.** Order totals are stored without a currency; online payment refuses non-INR, but a USD→INR switch would reinterpret old totals.
5. **Refunds are manual.** The order is flagged `REFUND_DUE`, staff are alerted and the customer is told; the refund itself is done in the Razorpay dashboard.
6. **WhatsApp 24-hour rule:** staff alerts and customer messages outside the window may not be delivered without approved templates (unchanged from Release 1).
7. **Chat content retention** is unlimited. Define a retention period before processing real customer data.
8. **Real-service verification pending.** Contract tests and the fakes pin the documented payloads, but only a run with real Razorpay test keys and a WhatsApp number proves them.
9. `verifyCallbackSignature` is implemented and unit-tested but deliberately unused: redirect parameters never change state (D-003).
