# 1. Product Requirements Document — StockSync Inventory Platform

## 1.1 Goal
A fully dynamic inventory management platform for small and mid-sized businesses. It ships as a
**web dashboard** (also installable as a mobile **PWA app**) plus a **public storefront website**, and
is integrated with **WhatsApp, Facebook Messenger, Instagram and Telegram** so that customers can
check stock, check prices and place orders from chat, and staff receive low-stock alerts on chat.
Runs on **Microsoft Azure**.

## 1.2 Users & Roles
| Role | Can do |
|---|---|
| `admin` | Everything, plus manage users and settings |
| `staff` | Manage products, stock, warehouses, suppliers, customers, orders |
| `viewer` | Read-only dashboard access |
| Customer (anonymous) | Browse the public catalog, order through the website or a chat channel |

## 1.3 Functional Objectives
1. **Auth**: email/password login with JWT. Bootstrap admin from env. Admin creates other users.
2. **Catalog**: categories; products with SKU, name, description, unit, price, reorder level, image,
   active flag and **dynamic custom attributes** (key/value pairs defined in Settings).
3. **Warehouses**: multiple locations; stock is tracked per product per warehouse.
4. **Stock movements**: receive (IN), issue (OUT), adjust (set absolute count), and transfer between
   warehouses. Every change is written to an immutable movement ledger with user and reason.
   Stock can never go negative.
5. **Suppliers & Customers**: CRUD. Customers are auto-created from chat channels.
6. **Orders**: created by staff, the website, or chat. Lifecycle `PENDING → CONFIRMED → FULFILLED`,
   or `CANCELLED`. Confirming deducts stock atomically. Cancelling a confirmed order restocks it.
   The customer is notified on their channel when the status changes.
7. **Low-stock alerts**: when total stock for a product falls to or below its reorder level, push a
   live dashboard event and send a chat message to the alert recipients configured in Settings.
8. **Real-time dashboard**: KPIs (products, total units, stock value, low-stock count, pending
   orders) and a live event feed over Server-Sent Events.
9. **Chat bot** (all channels) commands: `help`, `catalog`, `stock <SKU>`, `price <SKU>`,
   `order <SKU> <qty>`, `status <order#>`. All inbound and outbound messages appear in an Inbox.
10. **Public website**: `/shop` shows active products, price and availability, a cart, and checkout
    with name and phone, plus an "Order on WhatsApp" deep link.
11. **Dynamic settings** (no redeploy needed): business name, currency, public WhatsApp number,
    default warehouse, alert recipients, custom attribute definitions.
12. **Images**: uploaded straight from the browser to Azure Blob Storage with a short-lived SAS URL.

## 1.4 User Flows
- *Receive goods*: Staff → Inventory → Receive → pick product, warehouse, qty → ledger + live update.
- *Chat order*: Customer sends `order TSHIRT-RED 2` on WhatsApp → a PENDING order is created and the
  customer gets the order number → staff confirm in the dashboard → stock is deducted and the
  customer gets a "confirmed" message → stock falls below the reorder level → staff get an alert.
- *Web order*: Customer → /shop → add to cart → checkout → PENDING order (channel `web`).

## 1.5 Acceptance Criteria
- All API inputs are validated (zod). Invalid input gets 400 with field errors.
- Stock is never negative, even under concurrent requests (row-level atomic SQL).
- Webhooks reject requests without a valid signature or secret (401/403).
- RBAC is enforced on every mutating route. Viewers get 403.
- `npm run typecheck`, `npm run lint` and `npm test` pass.

## 1.6 Edge Cases
Unknown SKU in chat; order quantity above available stock; duplicate SKU (409); transfer to the
same warehouse (400); cancelling a fulfilled order (409); a channel not configured (message logged,
send skipped); Meta webhook retries (handled idempotently by message id).

## 1.7 Non-Goals (v1)
~~Payments~~ (moved into Release 2, see 1.8), multi-tenant SaaS, barcode hardware integration, accounting/invoicing, native
iOS/Android binaries (the PWA covers mobile), multi-currency per order.

---

## 1.8 Release 2 — Payments & WhatsApp Tap-to-Order

### Goal
Customers can browse, build a cart and **pay** entirely inside WhatsApp (and the other chat channels) by tapping buttons,
or pay online from the web shop. Cash on delivery remains available. Paid orders confirm themselves.

### Functional requirements
- **FR-R2-1 Payment methods.** Each order has `paymentMethod` (`COD` | `ONLINE`) and `paymentStatus` (`UNPAID` | `PAID` | `REFUND_DUE`).
  Admins enable or disable online payment and COD in Settings. Online payment is offered only when Razorpay credentials are configured **and** the shop currency is INR.
- **FR-R2-2 Razorpay payment links.** For an ONLINE order the server creates a Razorpay Payment Link. The amount is always computed server-side from the order.
  The link expires after `payments.linkExpiryMinutes` (≥ 15). An unexpired link is reused instead of creating duplicates.
- **FR-R2-3 Webhook is the source of truth.** `POST /webhooks/razorpay` verifies `X-Razorpay-Signature` (HMAC-SHA256 of the raw body) and is idempotent per event id.
  On `payment_link.paid`: payment → PAID, order → `paymentStatus=PAID`, then the order is **auto-confirmed** from the default warehouse (stock deducted).
  If confirmation fails (e.g. stock ran out), the order is flagged `REFUND_DUE` and staff are alerted. `payment_link.expired/cancelled` update the payment.
- **FR-R2-4 Chat payments.** After a chat order the customer chooses **Pay online** (receives a pay-link button) or **Cash on delivery**.
  When payment arrives they get "✅ Payment received — order #N confirmed".
- **FR-R2-5 Web checkout.** The shop checkout offers the enabled methods. ONLINE redirects to the Razorpay page, then back to `/shop/order/<token>`, which shows live payment and order status.
- **FR-R2-6 Staff tools.** The Orders page shows payment badges and a REFUND_DUE flag. Staff can (re)send a payment link to the customer's channel and copy it.
- **FR-R2-7 Tap-to-order (WhatsApp).** "hi", "menu" or any unknown text → welcome message with buttons **Browse · My cart · My orders**.
  Browse → category list → product list (10 per page, "More…" row) → product detail → quantity list (1–5, 10) → added to cart →
  buttons **Checkout · Keep shopping · Clear cart** → checkout summary → **Pay online · Cash on delivery** → order placed.
  **My orders** → last 5 orders → order detail with status.
- **FR-R2-8 Other channels.** The same flows render as Telegram inline keyboards and Messenger/Instagram quick replies.
  Any channel without rich support gets numbered text options. All v1 text commands keep working unchanged.
- **FR-R2-9 Chat cart.** One cart per chat customer, persisted, capped at available stock, cleared after checkout.

### Flows
1. *WhatsApp tap-to-pay:* hi → Browse → Apparel → Red T-Shirt → qty 2 → Checkout → Pay online → taps "Pay ₹998" → Razorpay UPI → webhook → order confirmed, stock deducted, customer notified, dashboard updates live.
2. *Web online checkout:* /shop → cart → "Pay online" → Razorpay → back to /shop/order/<token> → "Paid ✓ Order #N confirmed".
3. *COD:* any channel → Cash on delivery → PENDING order → staff confirm as in v1.

### Acceptance criteria
- Forged or unsigned Razorpay webhooks → 401, with no state change. Replayed events → no double confirmation or double stock deduction.
- The amount sent to Razorpay always equals the order total in paise. Clients can't influence it.
- Paid-but-unfulfillable orders end as `REFUND_DUE` with a staff alert, never silently lost.
- WhatsApp payloads respect platform limits (≤ 3 reply buttons, ≤ 10 list rows, title lengths). Telegram `callback_data` ≤ 64 bytes.
- All gates green. Payment and webhook flows covered by contract tests against Razorpay's documented payloads. A browser E2E test covers web online checkout against a local fake Razorpay.

### Edge cases
Product deactivated or out of stock while in a cart. Link expired before paying. A customer pays twice via an old link. Webhook arrives before the redirect.
Currency not INR. Razorpay not configured (online option hidden). A button tap from an old message after the cart changed. Long product names.

### Non-goals (Release 2)
Automated refunds via API (staff refund in the Razorpay dashboard; the order is flagged), partial payments, subscriptions, multi-currency,
the WhatsApp Commerce/Catalog API (Meta-hosted product catalogs), saved cards, invoicing/GST.

### Credentials needed (human)
Razorpay **test-mode** Key ID + Key Secret + Webhook Secret (free; dashboard → Test Mode → API Keys / Webhooks), later live keys after KYC.
WhatsApp Cloud API access as in v1. Until keys exist, everything is verified with contract tests and a local fake Razorpay, and labelled unverified against the real service.

### 1.8.1 Additions discovered while building and reviewing Release 2
- **FR-R2-10 Resume payment.** A web shopper whose payment link expired or who backed out can get a fresh link from the order page; the shop remembers the last unpaid online order ("Continue payment").
- **FR-R2-11 Refund handling.** `REFUND_DUE` (paid but unfulfillable, duplicate, or cancelled-after-paid) alerts staff and tells the customer; staff refund in Razorpay and press **Mark refunded** (`REFUNDED`).
- **FR-R2-12 Abuse limits.** At most 15 open orders per customer (chat and web); public endpoints rate limited.
- **FR-R2-13 Configuration safety.** Settings warns when no payment method would be usable; production refuses non-https provider URLs.

---

## 1.9 Release 3 — Reliable messaging & operations (Tier 1 of the "top 1%" roadmap)

### Goal
Every customer and staff message is delivered or visibly failed (never silently lost), WhatsApp messages outside the
24-hour window still arrive via approved templates, the database cleans up after itself, and operators can tell at a
glance whether the system is healthy. Then prove payments and WhatsApp against the real services with test keys.

### Functional requirements
- **FR-R3-1 Durable outbound messages (outbox).** Every outbound message is first stored in `channel_messages` with status
  `queued`, then sent immediately. A send that fails with a retryable error (network, 429, 5xx) is retried by a background
  worker with exponential backoff and jitter (max 6 attempts over ≈ 1 h); a permanent error (4xx) or exhausted retries ends
  as `failed` with the provider error code. Nothing outbound is lost if the process restarts mid-send.
- **FR-R3-2 Delivery receipts.** WhatsApp status webhooks (`sent`, `delivered`, `read`, `failed`) update the stored message,
  idempotently and only forward (`sent → delivered → read`; `failed` is terminal). The Inbox shows ticks and a red
  failed badge with the reason; staff can **Retry** a failed message.
- **FR-R3-3 WhatsApp 24-hour window and templates.** The app knows each WhatsApp user's last inbound time. Proactive
  messages (order confirmed/cancelled, payment received, refund, low-stock alert, payment link) to a user outside the
  window are sent as the approved **template** mapped to that event in Settings. Error 131047 (re-engagement required)
  on a free-form send falls back to the template once. Without a mapped template the message fails visibly with
  "outside 24h window — no template configured".
- **FR-R3-4 Background jobs.** A Postgres-backed job queue (`jobs` table, `FOR UPDATE SKIP LOCKED`) runs retries and
  scheduled maintenance. It is safe with several replicas, survives restarts and drains on SIGTERM.
- **FR-R3-5 Maintenance (configurable in Settings → Maintenance).** Hourly: cancel unpaid ONLINE orders older than
  `unpaidOrderTtlHours` (default 48, also cancels their Razorpay link and tells chat customers). Daily: delete
  `webhook_events` older than 30 days; delete chat messages older than `chatRetentionDays` (default 365, 0 = keep).
- **FR-R3-6 Health & operations.** `/healthz` stays a cheap liveness probe; new `/readyz` checks the database,
  migrations and the job worker heartbeat (503 when not ready). `GET /api/ops/status` (admin) shows queue depth, failed
  messages (24 h), oldest pending job and last maintenance runs, also shown as a card on the dashboard.
- **FR-R3-7 Real-service verification (needs human credentials).** A runbook and script that, with Razorpay **test**
  keys and a WhatsApp test number, create a real payment link, receive the real signed webhook and send a real
  interactive message and template. Results are recorded in `docs/7_SECURITY_AUDIT.md`, replacing "unverified".

### Acceptance criteria
- Kill the process between storing and sending a message → after restart it is sent exactly once (no duplicates while
  a worker holds the lock; the provider message id is stored).
- A provider returning 500 twice then 200 → message ends `sent` after two retries; returning 400 → `failed` immediately.
- Forged or unsigned status webhooks → 401/403; replayed statuses → no regression of state.
- Two workers never run the same job at once (concurrency test with two pollers).
- Maintenance never touches PAID, CONFIRMED or COD orders; never deletes stock movements or orders.
- All gates green; the existing 41 test files keep passing unchanged in behaviour.

### Edge cases
Template mapped but rejected by Meta (error code stored, failed visibly). Status webhook arriving before the send
response stored the message id. Retry after the customer's channel was unconfigured. Clock skew in webhook timestamps.
Telegram/Messenger have no 24h-template concept (Messenger's 24h rule: message tags are out of scope; failures shown).

### Non-goals (Release 3)
Template authoring/approval inside the app (templates are created in Meta WhatsApp Manager; we only map names),
Messenger message tags, an external queue/broker (Service Bus, Redis), multi-replica SSE (Tier 3).

### 1.9.1 Status (2026-11-26)
FR-R3-1 to FR-R3-6 are built and tested (T59–T66, T68). **FR-R3-7 (real-service verification) is NOT done:** the script and runbook exist (`scripts/verify/real-services.mjs`, DEPLOYMENT_GUIDE §5.8) but T67 is blocked until the owner provides Razorpay test keys and a WhatsApp test number. Additional finding fixed while building: template parameters built from customer-controlled text are normalised (R3-01).


---

## 1.10 Release 4 — Procurement, GST invoicing, barcode & automatic refunds (Tier 2 of the roadmap)

### Goal
Close the loop a small Indian retailer lives in every day: **buy** stock (purchase orders), **sell** it with a legal **GST invoice**, **count** it with a phone camera, and **refund** customers without leaving the app.

### Functional requirements
- **FR-R4-1 Purchase orders.** A PO belongs to a supplier and has lines (product, quantity, unit cost). Lifecycle `DRAFT → SENT → PARTIALLY_RECEIVED → RECEIVED`, or `CANCELLED` (only before any receipt). Receiving goes **only through StockService** (one receipt per line per call, idempotent on a client-supplied receipt id, never over-receiving a line). Costs are integer minor units.
- **FR-R4-2 Reorder suggestions.** Products at or below their reorder level are listed with a suggested quantity (`max(reorderLevel × 2 − total − quantity already on open purchase orders, 0)`; products fully covered by open orders are not suggested) and their usual supplier (the supplier of the most recent PO line for that product). One click creates a DRAFT PO per supplier.
- **FR-R4-3 GST invoices.** Each product has an HSN/SAC code and a GST rate (basis points, e.g. 1800 = 18 %). Settings hold the seller's legal name, GSTIN, address, state code, invoice prefix and whether prices include tax (default yes, as MRP). An invoice is created when an order is confirmed (idempotent), has a **gapless sequential number per financial year** (April–March, e.g. `INV/2026-27/000042`), is an **immutable snapshot** of seller, buyer, lines and tax, and splits tax into CGST+SGST (same state) or IGST (different state). Tax is computed per line in integer paise; line taxes sum exactly to the invoice tax and the invoice total equals the order total. A cancelled order's invoice becomes `VOID` (the number is never reused).
- **FR-R4-4 Invoice delivery.** Staff download a PDF from the Orders page; the customer gets it from their order status page (token link, only once confirmed) and as a WhatsApp document when the order is confirmed (template-aware like all notifications).
- **FR-R4-5 Barcodes.** Products have an optional unique barcode (EAN-13/UPC/Code-128 text). `GET /api/products/by-barcode/:code` resolves a scan. The web app scans with the phone camera (`BarcodeDetector` where supported) or a USB/Bluetooth scanner acting as a keyboard, in Inventory operations and Stock counts.
- **FR-R4-6 Stock counts.** A count session records counted quantity per product for one warehouse; submitting computes variances against the system and applies them as ADJUST movements through StockService with reason "Stock count #N". Counts can be captured offline on the phone and synced later.
- **FR-R4-7 Automatic refunds.** For a REFUND_DUE order staff press **Refund via Razorpay**: the server refunds exactly the captured amount (never client-supplied), idempotently; the `refund.processed` webhook (signature-verified, event-id idempotent) moves the order to REFUNDED and tells the customer; `refund.failed` flags it for manual handling. "Mark refunded" stays for refunds done outside the app.

### Acceptance criteria
- Receiving the same receipt id twice changes stock once; receiving more than ordered is refused; all stock changes appear in the movement ledger with the PO number.
- Invoice numbers have no gaps or duplicates under 30 concurrent confirmations; regenerating an invoice never changes its number or amounts; for random carts and rates, `sum(line tax) == invoice tax` and `taxable + tax == total` exactly.
- Invoice PDFs open, show GSTIN/HSN/CGST/SGST or IGST and the amount in words, and are only reachable by staff or the order's own token.
- A refund is issued at most once per payment even with double-clicks and webhook replays; the amount sent always equals the captured amount.
- All gates green; existing tests unchanged in behaviour.

### 1.10.1 Status (2026-11-26)
FR-R4-1 to FR-R4-7 are built and tested against fakes (T69–T85). Differences from the plan: reorder suggestions subtract quantity already on open purchase orders; tax-exclusive pricing is computed but not issued (D-017); partial Razorpay refunds are recognised and not announced as complete (R4-01); invoice PDFs embed Noto Sans and Noto Sans Devanagari so ₹ and Hindi names print (T87); other scripts show `?`. Real-service verification of refunds and the idempotency header waits on T67.

### Non-goals (Release 4)
E-invoicing IRN/QR through the government portal, GST returns filing, e-way bills, batch/expiry and variants (Release 4b), partial refunds, supplier portals, multi-currency.

### Credentials needed (human)
None to build. Real verification of refunds reuses the Razorpay test keys (see 1.8 and DEPLOYMENT_GUIDE §5.8). The seller's real GSTIN is entered in Settings by the owner; a **chartered accountant should review the invoice format** before real use.

---

## 1.11 Release 5 — Scale & intelligence (Tier 3 of the roadmap)

### Decisions (owner, 2026-11-26)
Tenancy: **one shared database with PostgreSQL row-level security**. Billing: **Free / Pro / Business plans, monthly, Razorpay Subscriptions**, prices configurable by the platform operator (not in code). Languages: **English + Hindi** for the app, and **English/Hindi/Hinglish** for AI chat ordering.

### Goal
Many independent businesses use one StockSync installation safely (a bug must not be able to leak one shop's data to another), can sign up and pay by themselves, scale beyond one server, and get an AI assistant for ordering and inventory questions, with analytics and an accessible, fast, bilingual UI.

### Functional requirements
- **FR-R5-1 Tenancy.** Every business table carries `tenant_id`. The app connects as a non-owner role, every query runs with `app.tenant_id` set, and RLS policies (`FORCE`d) refuse any row of another tenant for reads and writes, **even for raw SQL with no WHERE**. No tenant context means no rows. SKUs, barcodes, numbers (orders, POs, counts, invoices) and settings are unique **per tenant**. Platform staff are a separate role with their own routes.
- **FR-R5-2 Per-tenant channels.** Each tenant stores its own WhatsApp, Messenger/Instagram, Telegram and Razorpay credentials, encrypted at rest (AES-256-GCM, key from Key Vault), write-only in the UI. Webhooks route to the right tenant (Meta by phone-number/page id, Razorpay and Telegram by tenant id in the URL) and are verified with that tenant's secret.
- **FR-R5-3 Public shop per tenant** at `/shop/<slug>`; order links stay unguessable and global.
- **FR-R5-4 Sign-up and onboarding.** Anyone can create a business (rate-limited, email verified), lands in a checklist wizard with optional demo data.
- **FR-R5-5 Plans and limits.** Plan limits (products, staff users, monthly chat messages, monthly invoices) are enforced with clear errors and visible usage; trial 14 days; exceeding never deletes data.
- **FR-R5-6 Billing.** Razorpay Subscriptions on the platform's own account: subscribe, change plan, cancel, failed-payment grace period then downgrade to Free (read-only over limit), all by signed webhook.
- **FR-R5-7 Platform console and audit.** Platform staff list tenants, see usage, change plan, suspend/unsuspend; every tenant has an audit log of who changed what; no impersonation.
- **FR-R5-8 Data rights.** A tenant admin can export all their data and request deletion (30-day hold); a customer's data can be erased on request.
- **FR-R5-9 Scale-out.** Realtime events work across replicas (Postgres LISTEN/NOTIFY, tenant-filtered); API and worker can run as separate Container Apps; sessions use httpOnly cookies with CSRF protection and refresh rotation; per-tenant and per-plan rate limits.
- **FR-R5-10 AI ordering (Claude API).** Free-text chat (English/Hindi/Hinglish) becomes a cart through a tool-using agent limited to the customer's own cart and the tenant's catalogue; **an order is never placed without the customer tapping a confirmation button**; customer text is treated as data (prompt-injection safe); per-tenant monthly AI budget with a hard stop and a kill switch; the tap menu always remains the fallback.
- **FR-R5-11 Ask your inventory.** Staff ask questions in the dashboard; the assistant has read-only tools scoped to the tenant and cites the numbers it used.
- **FR-R5-12 Forecasting.** Statistical demand forecast (trend + weekly seasonality, back-tested) improves reorder suggestions; the LLM only explains, never computes.
- **FR-R5-13 Analytics.** Sales by day/product/channel, margins (from purchase cost), dead stock, best sellers, chat → order → paid funnel.
- **FR-R5-14 Bilingual UI and bot.** Hindi translations for every screen and customer message, per-user and per-customer language; accessibility to WCAG 2.2 AA; performance budgets enforced in CI.

### Acceptance criteria
- Two-tenant isolation tests: for every route, tenant B can never read, change or even detect tenant A's data (404, not 403); raw SQL under tenant B's role returns zero of A's rows; a request with no tenant context sees nothing.
- A webhook signed with tenant A's secret is rejected for tenant B.
- Exceeding a plan limit returns a clear 402/403 and never loses data; a failed subscription payment downgrades after the grace period, by signed webhook only.
- AI: a customer message that tries to change prices, read other customers, or place an order without confirmation is refused in the eval suite; spend stops at the budget.
- Event delivered through a second replica; sessions survive CSRF attempts; all gates green and the multi-tenant browser e2e passes.

### Non-goals (Release 5)
White-label domains per tenant, a native mobile app, marketplace/multi-vendor carts, voice ordering, tax regimes outside India.

### Credentials needed (human)
Anthropic API key (AI), the platform's own Razorpay keys (subscription billing; separate from tenants' keys), an email-sending service for sign-up verification (Azure Communication Services Email recommended), and an encryption key generated into Key Vault.
