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

**Date:** 2026-11-06 · **Scope:** `src/api` payments, webhooks, chat flow, public checkout; `src/web` shop, order page, admin payment UI; `scripts/e2e`; dependencies · **Result:** ✅ PASSED — all 15 findings fixed (none open); accepted risks listed in 7.R2.5
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
| R2-15 | Medium | One chat or web customer could create unlimited open orders (40 in a probe) | T57 (max 15 open orders per customer, enforced centrally under a row lock; staff-entered orders exempt; HTTP 429 / chat message) |

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

---

# 7.R3 Release 3 Audit — Reliable Messaging & Operations

**Date:** 2026-11-26 · **Scope:** `src/api` outbox, job queue, delivery receipts, WhatsApp templates, maintenance jobs, `/readyz`, `/api/ops/status`, shutdown; `src/web` Inbox, Settings, Dashboard · **Result:** ✅ PASSED — 1 finding fixed, 1 new dependency advisory accepted, none open at high or critical.
**Method:** abuse-case review of each new input and background path, reproduced defect fixed test-first (the regression test failed before the fix), permanent suite `tests/securityRelease3.test.ts`.
**Not verified:** behaviour against the *real* Razorpay and Meta services, and the Bicep probe change (no `az` CLI in the build environment). The runbook for the real run is `docs/DEPLOYMENT_GUIDE.md` §5.8 and T67 is **blocked** until the owner supplies test credentials. The WhatsApp template-parameter rules below come from Meta's documentation and are not yet confirmed against the live API.

## 7.R3.1 Automated checks
| Check | Result |
|---|---|
| `npm audit --omit=dev --audit-level=high` (the gate) | ✅ no high or critical |
| `npm audit` (all) | ⚠️ 3 moderate, all one chain: `@opentelemetry/instrumentation-http` via `applicationinsights` (see R3-04) |
| Secret scan of tracked files (live/test key and token patterns) | ✅ none |
| typecheck, lint, tests, build | ✅ green (see `6_STATE_SUMMARY.md` for the latest counts) |

## 7.R3.2 Attack classes tested (`tests/securityRelease3.test.ts`, `deliveryStatus.test.ts`, `messageRetry.test.ts`, `ops.test.ts`)
| Class | Result |
|---|---|
| Forged / unsigned delivery-receipt webhook | ✅ 401, no state change |
| Replayed or out-of-order receipts | ✅ state only moves forward; `failed` is terminal |
| Receipt for another channel's message with the same provider id | ✅ ignored (update is scoped to channel `whatsapp`) |
| Retry amplification (provider always failing) | ✅ at most 7 sends per message (1 immediate + 6 queued), then `failed` and no pending job |
| Retry endpoint hammered (15 parallel calls) | ✅ exactly one 202, the rest 409; one job, one send |
| Retrying a message that is not failed, inbound, unknown or malformed id | ✅ 409 / 404; viewers 403, anonymous 401 |
| `/api/ops/status` by staff, viewer, anonymous | ✅ 403 / 403 / 401 (admin only) |
| `/readyz` information leak when the database is down | ✅ booleans only, no error text |
| User-controlled text in template parameters | ✅ fixed, see R3-01 |

## 7.R3.3 Controls verified
| Area | Control | Evidence |
|---|---|---|
| Durability | A message and its send job are created in one SQL statement, so a crash between storing and sending still sends exactly once | `outbox.test.ts` |
| Concurrency | Jobs are claimed with `FOR UPDATE SKIP LOCKED`; two workers never run one job twice; a worker that died is reclaimed, and a job that keeps killing workers ends `dead` | `jobs.test.ts` |
| Retention | Prune never deletes orders, stock movements or queued messages; retention 0 keeps everything | `maintenance.test.ts` |
| Order expiry | Cancels only unpaid ONLINE PENDING orders past the TTL through the normal cancel path (link cancelled, customer told) | `maintenance.test.ts` |
| Templates | Free-form inside 24 h, template outside it, visible `NO_TEMPLATE` failure when unmapped, one fallback on Meta error 131047, bot replies never use templates | `templates.test.ts` |
| Shutdown | HTTP stops, scheduler stops, jobs drain, pool closes, forced exit after 25 s | `shutdown.test.ts` |

## 7.R3.4 Findings and fixes
| ID | Severity | Finding | Fix |
|---|---|---|---|
| R3-01 | Medium | Customer-controlled text (WhatsApp profile name, product name) went into template parameters unchanged. Meta rejects newlines, tabs and 4+ consecutive spaces (error 132018), so one customer could make their own order notifications fail permanently, and a long value was not capped | `templateText()` in `channels/hub.ts` collapses whitespace, caps at 1024 characters and substitutes `-` for empty values |
| R3-04 | Low (moderate advisory) | `npm audit` reports 3 moderate advisories in `@opentelemetry/instrumentation-http`, pulled in by `applicationinsights` (new since Release 2). Not reachable at the high level the gate enforces | Accepted. Upgrade `applicationinsights` when a non-breaking fix exists; do not run `npm audit fix --force` (it proposes a breaking change) |

## 7.R3.5 Accepted risks and recommendations
1. **Real-service verification pending (T67 blocked).** Contract tests and fakes cover the documented formats only. Run `docs/DEPLOYMENT_GUIDE.md` §5.8 with test keys before go-live.
2. **A receipt that arrives before the send response is stored is ignored.** The message is already `sent`; only a `delivered` or `read` tick can be missed in that race.
3. **Error text from providers is stored** (`error_message`, 500 characters) and shown to staff in the Inbox. Provider messages do not contain our credentials, and adapters never include tokens in their own errors, but treat that column as internal.
4. **The job worker runs inside the API process.** A heavy burst of retries shares CPU with requests. Split into a separate Container App revision if volume grows.
5. **`/readyz` checks this replica's own heartbeat.** With one replica (current design) a dead worker takes the app out of rotation, which is intended; revisit when scaling out with Web PubSub.
6. **Single-replica realtime** and **JWT in `localStorage`** are unchanged from earlier releases (7.4).
7. **Bicep probe and termination-grace changes are uncompiled** in this environment. Run `az bicep build --file infra/main.bicep` before deploying.
8. **Template approval is outside the app.** A rejected or paused template shows up as a failed message with Meta's error code.

---

# 7.R4 Release 4 Audit — Procurement, GST, Barcode & Refunds

**Date:** 2026-11-26 · **Scope:** purchase orders and reorder, GST engine, invoices and PDFs, signed download links, WhatsApp invoice delivery, barcodes, stock counts and offline queue, Razorpay refunds · **Result:** ✅ PASSED — 2 findings fixed (one pre-existing), none open at high or critical.
**Method:** abuse-case review of every new input and money path; each defect reproduced by a failing test before it was fixed; permanent suite `tests/securityRelease4.test.ts` plus the per-feature suites.
**Not verified:** anything against the real Razorpay or Meta services (the refund API, the `X-Refund-Idempotency` header and the refund webhook payloads follow Razorpay's documentation as recalled and are untested live; T67 stays blocked on credentials), and the invoice layout against an accountant's expectations. The Bicep changes from Release 3 are still uncompiled.

## 7.R4.1 Automated checks
| Check | Result |
|---|---|
| `npm audit --omit=dev --audit-level=high` (the gate) | ✅ no high or critical (the 3 moderate `applicationinsights` advisories from R3-04 remain) |
| New dependencies | `pdfkit 0.20.2` (MIT, pinned; 0.21.0 was six days old so not used), `@fontsource/noto-sans` and `@fontsource/noto-sans-devanagari` 5.3.0 (SIL OFL 1.1, pinned), `fake-indexeddb 6.2.8` (dev only, test fakes) |
| Secret scan of tracked source | ✅ none |

## 7.R4.2 Attack classes tested
| Class | Result |
|---|---|
| PO receipt replay, same receipt id on another order, over-receiving, concurrent receipts | ✅ idempotent per order, refused atomically, three parallel receipts: one wins (`purchaseOrders.test.ts`, R4-05) |
| Negative, zero, fractional or huge quantities on receipts and counts | ✅ 400 |
| Invoice numbers under 30 concurrent confirmations; regenerating an invoice | ✅ gapless 1..30; snapshot immutable (`invoices.test.ts`) |
| Invoice IDOR: viewer, anonymous, another shopper's token, an order id used as a token | ✅ 403 / 401 / no data / 404 |
| Signed invoice links: tampered, expired, pointed at another invoice, wrong key | ✅ all plain 404 (`invoiceDelivery.test.ts`, R4-03) |
| Refund amount tampering (client-sent amount, payment id, short payment) | ✅ ignored; the amount is what Razorpay captured per our records |
| Refund double-click, concurrent staff, replayed webhooks | ✅ one refund; customer told once |
| Hostile names reaching the PDF (PDF operators, JavaScript objects, bidi override, non-Latin text) | ✅ rendered as text inside hex strings, never interpreted |
| Barcode lookup with SQL-looking, NUL, oversized or malformed codes | ✅ 404, never 500 |

## 7.R4.3 Findings and fixes
| ID | Severity | Finding | Fix |
|---|---|---|---|
| R4-01 | Medium | A `refund.processed` webhook for **less than the captured amount** (staff can issue partial refunds in the Razorpay dashboard) marked the order REFUNDED and told the customer they had been refunded in full | A refund below the captured amount is recorded as incomplete on the payment, the order stays REFUND_DUE, the customer is told nothing, and staff are alerted to refund the rest (`payments.ts onRefundEvent`) |
| R4-02 | Medium (pre-existing) | A NUL character (U+0000) in any text field made the API answer **500** (Postgres cannot store it). Worse, a chat message or profile name containing one made the inbound webhook fail, so Meta would retry it repeatedly | The error handler maps Postgres 22021 to a clean 400, and inbound chat text, sender and profile names are stripped of NUL before they reach the database (`middleware/errors.ts`, `services/inbox.ts`) |

## 7.R4.4 Accepted risks and recommendations
1. **Signed invoice links are bearer capabilities for 2 hours.** Anyone holding the link (it travels in a chat message) can download that one invoice, which contains the buyer's name and, for business buyers, GSTIN. They are bound to a single invoice, expire, are checked in constant time, and a voided invoice downloads marked VOID. Shorten `INVOICE_LINK_TTL_MS` if that is too long.
2. **`GET /api/orders/:id/invoice(.pdf)` issues the invoice on first call** (a GET with a side effect). Safe here because it is idempotent, staff-only and authenticated by a bearer header, not a cookie, so cross-site request forgery does not apply. If cookie sessions are adopted (Release 5), change it to POST.
3. **Invoice PDFs cover Latin and Devanagari only** (Noto Sans and Noto Sans Devanagari, OFL, embedded and subset; T87). Other scripts and emoji print as `?`. If the font packages are missing the renderer falls back to Helvetica and `Rs.`. Hostile text is still sanitised and drawn as glyphs, never as PDF syntax.
4. **Tax-exclusive pricing is computed but never issued** (D-017), so an invoice can never disagree with the amount charged.
5. **The invoice format is unreviewed by an accountant.** Review a sample before relying on it; e-invoicing (IRN/QR) is out of scope.
6. **Refund idempotency relies on Razorpay honouring `X-Refund-Idempotency`.** Our own claim (one PENDING refund per payment, a 60-second guard after an unknown outcome, one stable key per attempt) means a duplicate refund needs both a Razorpay-side miss and a deliberate staff retry; the first live run (T67) should confirm the header's behaviour.
7. **A refund whose webhook never arrives** leaves the order REFUND_DUE with a PENDING refund; staff can use Mark refunded after checking the Razorpay dashboard.
8. **The offline queue lives in the browser's IndexedDB** and is readable by anyone using that device profile; it holds only product ids and quantities, no personal data.
9. **Barcode lookups are authenticated but not separately rate-limited**; they sit under the general API limiter.

## 7.R5a Tenancy security review (T95)

Scope: isolation between businesses on the shared database. Suite: `src/api/tests/securityTenancy.test.ts` (15 tests), run on every gate.

| # | Area | Result |
|---|---|---|
| 1 | IDOR matrix: every parameterised route (30 entries) called by business B with business A's ids | All 404 (refund 501 / invoice 409 only where a precondition fails before any lookup, identical for every id); A's data byte-identical afterwards |
| 2 | Route-table guard: any new parameterised route fails the suite until it is in the matrix or a reviewed exemption | In place; also guards new top-level API mounts |
| 3 | Foreign ids in request bodies (category, customer, product, warehouse, supplier, count, default warehouse) | All refused 400/404/409; raw SQL refused by composite foreign keys (migration 017) |
| 4 | SQL injection payloads in search/filter parameters | No 5xx, no widening of results (parameterised queries throughout) |
| 5 | Database role escape: DDL, COPY PROGRAM, DISABLE RLS, platform tables, role creation | All denied for the app role |
| 6 | Forged tokens: wrong tenant for a user, wrong secret, expired, `alg:none`, platform type | All 401 |
| 7 | Webhook spoofing: the operator's own Meta secret against another business's URL | Refused; the default business is unaffected |
| 8 | Slug enumeration: suspended vs unknown shop | Byte-identical responses |

Findings
- **R5-01 (medium, fixed): `SET ROLE` was applied once per physical connection.** Injected SQL that ran `RESET ROLE` left that pooled connection as the owner (RLS bypass) for later requests. The pool now re-asserts the role and tenant on every checkout in one round trip, so the effect lasts one checkout at most. Regression test included.
- **R5-02 (info, documented): `SET ROLE` mode can never be fully safe against injection**, because the session user is the owner. Production should set `DATABASE_APP_URL` (restricted login role); the suite shows `RESET ROLE` and `SET ROLE postgres` do nothing there.
- **R5-03 (info):** a primary-key collision on `stock_levels (product_id, warehouse_id)` can only be provoked by raw SQL that already knows another business's ids; not reachable via the API.

Accepted / open: `TENANT_FALLBACK=default` must be removed before sign-up opens (T96). Ciphertext swap between businesses and platform-console isolation are covered in `tenantChannels.test.ts` and `tenantAuth.test.ts`.
