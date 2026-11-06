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

## 1.9 Release 3 — Inventory standard parity (Zoho Inventory class)
**Goal.** Close the functional gap between StockSync and mainstream small-business inventory software while keeping its chat and online-payment advantage.
**Method.** Gap analysis against Zoho Inventory's published feature list. Out of scope for R3: multi-currency, e-commerce marketplace connectors, shipping-carrier integrations, full accounting/GL, payroll, mobile native apps.

| ID | Requirement | Status before R3 |
|---|---|---|
| FR-R3-1 | Purchase orders with partial receiving against the PO | missing (suppliers CRUD only) |
| FR-R3-2 | Vendor bills, supplier payments, payables summary | missing |
| FR-R3-3 | Reorder suggestions with preferred supplier → draft PO | alerts only |
| FR-R3-4 | Tax rates (GST) and discounts, computed server-side | missing |
| FR-R3-5 | Immutable numbered sales invoices; printable invoice, packing slip, picklist | missing |
| FR-R3-6 | Sales returns with credit notes; purchase returns with debit notes | missing |
| FR-R3-7 | Composite items (bundles/kits) | missing |
| FR-R3-8 | Barcode assignment, label generation, scan lookup | missing |
| FR-R3-9 | Batch/lot with expiry (FEFO) and serial number tracking; expiry alerts | missing |
| FR-R3-10 | Weighted-average costing and stock valuation | missing |
| FR-R3-11 | Reports (sales, purchases, margin, movement, low stock, ageing) with CSV export | dashboard only |
| FR-R3-12 | CSV import of products and opening stock with dry-run | missing |
| FR-R3-13 | Append-only audit log | missing |
**Already at parity or better:** multi-warehouse, transfers, adjustments and ledger, custom fields, roles, reorder alerts, online payments (Razorpay), WhatsApp/Telegram/Messenger/Instagram ordering, public shop, PWA.
**Success measure.** A shop owner can run buy → receive → sell → invoice → return → report without leaving StockSync, and every stock and money figure reconciles with the ledger.

### 1.9.1 Retail experience and QR (added after owner request: QR scan, learn from DMart and similar)
| ID | Requirement |
|---|---|
| FR-R3-14 | Price, MRP and savings shown; minimum order value and delivery fee |
| FR-R3-15 | Pick-up or delivery, time slots with capacity, serviceable pincodes |
| FR-R3-16 | Order again from a past order (web and chat) |
| FR-R3-17 | QR codes for products, the shop and a WhatsApp start link |
| FR-R3-18 | Camera scanning of barcodes and QR codes in the web app (with scanner and manual fallback) |
| FR-R3-19 | Handover QR: customer shows it, staff scan to complete pick-up or delivery |
| FR-R3-20 | UPI QR payment at the counter, confirmed only by the signed webhook |
**Not copied:** loyalty programs, coupons, store-level pricing and rider tracking (no verified detail, and they need data we do not have).

### 1.9.2 Catalogue depth, credit and operations (added after review of what was missing)
| ID | Requirement |
|---|---|
| FR-R3-21 | Units of measure and fractional quantities (kg, g, l, ml, pack) |
| FR-R3-22 | Item groups with variants (size, colour) in admin, shop and chat |
| FR-R3-23 | Stocktake with variance adjustments and scan-to-count |
| FR-R3-24 | Supplier price lists, cost history, cheapest-supplier reorder |
| FR-R3-25 | Search, filters, pagination and a load test at realistic size |
| FR-R3-26 | Customer credit ledger, limits, receipts, statements, ageing, reminders |
| FR-R3-27 | Send invoices, statements and POs by WhatsApp and email |
| FR-R3-28 | Accounting export (CSV and Tally XML) |
| FR-R3-29 | Hindi and regional-language shop, chat and documents |
| FR-R3-30 | Backups with a tested restore, data retention and deletion requests |
**Explicitly out of scope (owner decision):** GST return filing (GSTR, e-invoice, e-way bill) and a counter point-of-sale mode with receipt printer and offline billing. Tax on invoices (FR-R3-4) stays.
