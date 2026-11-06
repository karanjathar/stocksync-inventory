# 3. Schemas & Contracts

## 3.1 Database (PostgreSQL) — `src/api/migrations/001_init.sql`
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
  password_hash text NOT NULL, name text NOT NULL, role text NOT NULL CHECK (role IN ('admin','staff','viewer')),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text NOT NULL UNIQUE,
  name text NOT NULL, description text NOT NULL DEFAULT '', category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  unit text NOT NULL DEFAULT 'pcs', price_cents integer NOT NULL CHECK (price_cents >= 0),
  reorder_level integer NOT NULL DEFAULT 0 CHECK (reorder_level >= 0), image_url text,
  attributes jsonb NOT NULL DEFAULT '{}', is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE warehouses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE,
  name text NOT NULL, address text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE stock_levels (product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0), PRIMARY KEY (product_id, warehouse_id));
CREATE TABLE stock_movements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('IN','OUT','ADJUST','TRANSFER_IN','TRANSFER_OUT')),
  quantity_delta integer NOT NULL, balance_after integer NOT NULL, reason text NOT NULL DEFAULT '',
  reference text, user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE suppliers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  email text, phone text, notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  phone text, email text, channel text NOT NULL DEFAULT 'manual', channel_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (channel, channel_user_id));
CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number serial UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id), channel text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','CONFIRMED','FULFILLED','CANCELLED')),
  warehouse_id uuid REFERENCES warehouses(id), total_cents integer NOT NULL, notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity > 0), unit_price_cents integer NOT NULL);
CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE channel_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in','out')), external_user text NOT NULL,
  external_id text UNIQUE, text text NOT NULL, status text NOT NULL DEFAULT 'ok',
  created_at timestamptz NOT NULL DEFAULT now());
```

## 3.2 Core TypeScript Types — `src/api/src/domain/types.ts`
```ts
export type Role = 'admin' | 'staff' | 'viewer';
export type ChannelName = 'whatsapp' | 'messenger' | 'instagram' | 'telegram';
export type OrderChannel = ChannelName | 'web' | 'manual';
export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'FULFILLED' | 'CANCELLED';
export type MovementType = 'IN' | 'OUT' | 'ADJUST' | 'TRANSFER_IN' | 'TRANSFER_OUT';
export interface User { id: string; email: string; name: string; role: Role; createdAt: string }
export interface AuthUser { id: string; email: string; role: Role }
export interface Category { id: string; name: string }
export interface Product { id: string; sku: string; name: string; description: string; categoryId: string | null;
  unit: string; priceCents: number; reorderLevel: number; imageUrl: string | null;
  attributes: Record<string, string>; isActive: boolean; totalQuantity: number; createdAt: string; updatedAt: string }
export interface Warehouse { id: string; code: string; name: string; address: string }
export interface StockLevel { productId: string; sku: string; productName: string; warehouseId: string; warehouseCode: string; quantity: number }
export interface StockMovement { id: string; productId: string; sku: string; warehouseId: string; warehouseCode: string;
  type: MovementType; quantityDelta: number; balanceAfter: number; reason: string; reference: string | null;
  userId: string | null; createdAt: string }
export interface Supplier { id: string; name: string; email: string | null; phone: string | null; notes: string }
export interface Customer { id: string; name: string; phone: string | null; email: string | null; channel: OrderChannel | string; channelUserId: string | null }
export interface OrderItem { productId: string; sku: string; name: string; quantity: number; unitPriceCents: number }
export interface Order { id: string; number: number; customerId: string; customerName: string; channel: OrderChannel;
  status: OrderStatus; warehouseId: string | null; totalCents: number; notes: string; items: OrderItem[]; createdAt: string; updatedAt: string }
export interface AlertRecipient { channel: ChannelName; to: string }
export interface CustomFieldDef { key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[] }
export interface Settings { businessName: string; currency: string; whatsappNumber: string; defaultWarehouseId: string | null;
  alertRecipients: AlertRecipient[]; customFields: CustomFieldDef[] }
export interface ChannelMessage { id: string; channel: ChannelName; direction: 'in' | 'out'; externalUser: string; text: string; status: string; createdAt: string }
export interface InboundMessage { channel: ChannelName; from: string; text: string; externalId?: string; senderName?: string }
export type RealtimeEvent =
  | { type: 'stock.changed'; productId: string; sku: string; warehouseId: string; quantity: number; totalQuantity: number }
  | { type: 'stock.low'; productId: string; sku: string; name: string; totalQuantity: number; reorderLevel: number }
  | { type: 'order.created' | 'order.updated'; orderId: string; number: number; status: OrderStatus }
  | { type: 'message.received'; channel: ChannelName; from: string; text: string };
export interface DashboardStats { productCount: number; totalUnits: number; stockValueCents: number;
  lowStockCount: number; pendingOrders: number; ordersToday: number }
```

## 3.3 Channel Adapter Contract — `src/api/src/channels/types.ts`
```ts
export interface ChannelAdapter { readonly name: ChannelName; isConfigured(): boolean; send(to: string, text: string): Promise<void> }
```
Wire formats (outbound):
- WhatsApp: `POST https://graph.facebook.com/{ver}/{WHATSAPP_PHONE_NUMBER_ID}/messages`, Bearer `WHATSAPP_TOKEN`,
  body `{messaging_product:'whatsapp', to, type:'text', text:{body}}`
- Messenger / Instagram: `POST https://graph.facebook.com/{ver}/me/messages`, Bearer page token,
  body `{recipient:{id:to}, messaging_type:'RESPONSE', message:{text}}`
- Telegram: `POST https://api.telegram.org/bot{TOKEN}/sendMessage`, body `{chat_id:to, text}`

Inbound:
- `GET /webhooks/meta?hub.mode=subscribe&hub.verify_token=..&hub.challenge=..` → echoes the challenge
- `POST /webhooks/meta`, header `X-Hub-Signature-256: sha256=<HMAC(META_APP_SECRET, rawBody)>`
  - `object:'whatsapp_business_account'` → `entry[].changes[].value.messages[]{id, from, type:'text', text.body}`, `value.contacts[].profile.name`
  - `object:'page'` (messenger) / `'instagram'` → `entry[].messaging[]{sender.id, message{mid,text}}` (skip `message.is_echo`)
- `POST /webhooks/telegram`, header `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET` → `message{message_id, chat.id, text, from.first_name}`

## 3.4 REST API (JSON; prefix `/api`; errors `{error:{code,message,details?}}`)
| Method & Path | Role | Body / Query | Response |
|---|---|---|---|
| POST /auth/login | public | `{email,password}` | `{token,user}` |
| GET /auth/me | any | – | `User` |
| GET/POST /users | admin | `{email,password(min 8),name,role}` | `User[]` / `User` 201 |
| DELETE /users/:id | admin | – | 204 |
| GET/POST /categories | read / staff | `{name}` | `Category[]` / `Category` |
| DELETE /categories/:id | staff | – | 204 |
| GET /products | any | `?search&categoryId&lowStock=true` | `Product[]` |
| GET /products/:id | any | – | `Product` |
| POST /products | staff | `{sku,name,description?,categoryId?,unit?,priceCents,reorderLevel?,imageUrl?,attributes?,isActive?}` | `Product` 201 |
| PATCH /products/:id | staff | partial of the above | `Product` |
| DELETE /products/:id | staff | – | 204 |
| GET/POST /warehouses | any / staff | `{code,name,address?}` | `Warehouse[]` / `Warehouse` |
| PATCH/DELETE /warehouses/:id | staff | partial | `Warehouse` / 204 |
| GET /stock | any | `?productId&warehouseId` | `StockLevel[]` |
| POST /stock/receive | staff | `{productId,warehouseId,quantity>0,reason?,reference?}` | `StockLevel` |
| POST /stock/issue | staff | same | `StockLevel` (409 insufficient) |
| POST /stock/adjust | staff | `{productId,warehouseId,newQuantity>=0,reason}` | `StockLevel` |
| POST /stock/transfer | staff | `{productId,fromWarehouseId,toWarehouseId,quantity>0,reason?}` | `{from:StockLevel,to:StockLevel}` |
| GET /stock/movements | any | `?productId&warehouseId&limit` | `StockMovement[]` |
| CRUD /suppliers, /customers | any read / staff write | entity fields | entity |
| GET /orders | any | `?status` | `Order[]` |
| GET /orders/:id | any | – | `Order` |
| POST /orders | staff | `{customerId,items:[{productId,quantity}],notes?,warehouseId?}` | `Order` 201 |
| POST /orders/:id/confirm | staff | `{warehouseId?}` | `Order` (409 insufficient stock) |
| POST /orders/:id/fulfill, /cancel | staff | – | `Order` |
| GET /dashboard | any | – | `DashboardStats` |
| GET /events | any | – | `text/event-stream` of `RealtimeEvent` |
| GET /settings | any | – | `Settings` |
| PUT /settings | admin | partial `Settings` | `Settings` |
| GET /channels | any | – | `{name,configured}[]` |
| GET /messages | any | `?channel&limit` | `ChannelMessage[]` |
| POST /messages/send | staff | `{channel,to,text}` | 202 |
| POST /uploads/image-sas | staff | `{filename,contentType}` | `{uploadUrl,blobUrl}` (501 if not configured) |
| GET /public/catalog | public | – | `{settings:{businessName,currency,whatsappNumber},products:[{id,sku,name,description,priceCents,unit,imageUrl,inStock,available}]}` |
| POST /public/orders | public (rate-limited) | `{name,phone,items:[{productId,quantity}]}` | `{number,status,totalCents}` 201 |
| GET /healthz | public | – | `{status:'ok',db:'ok'}` |

## 3.5 Bot Command Grammar (case-insensitive)
`help` · `catalog` (top 10 active in stock) · `stock <SKU>` · `price <SKU>` · `order <SKU> <qty>` · `status <number>`.
Anything else → help text.

---
# Release 2 contracts (payments & tap-to-order)

## 3.6 Release 2 Database — `src/api/migrations/003_payments_chat.sql`
```sql
ALTER TABLE orders
  ADD COLUMN payment_method text NOT NULL DEFAULT 'COD' CHECK (payment_method IN ('COD','ONLINE')),
  ADD COLUMN payment_status text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PAID','REFUND_DUE')),
  ADD COLUMN public_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;     -- unguessable id for /shop/order/<token>

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'razorpay',
  provider_ref text NOT NULL UNIQUE,                 -- plink_xxx
  reference_id text NOT NULL UNIQUE,                 -- sent to Razorpay, e.g. ORD-42-1a2b
  status text NOT NULL CHECK (status IN ('CREATED','PAID','EXPIRED','CANCELLED')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL,
  short_url text NOT NULL,
  provider_payment_id text,                          -- pay_xxx once paid
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX payments_one_open_per_order ON payments(order_id) WHERE status = 'CREATED';

CREATE TABLE webhook_events (provider text NOT NULL, event_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id));

CREATE TABLE chat_carts (customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  items jsonb NOT NULL DEFAULT '[]',                 -- [{ "productId": uuid, "quantity": int }]
  updated_at timestamptz NOT NULL DEFAULT now());
```

## 3.7 Release 2 Types — additions to `src/api/src/domain/types.ts`
```ts
export type PaymentMethod = 'COD' | 'ONLINE';
export type PaymentStatus = 'UNPAID' | 'PAID' | 'REFUND_DUE' | 'REFUNDED';   // REFUNDED added by migration 004 (T58)
// Order gains: paymentMethod: PaymentMethod; paymentStatus: PaymentStatus; publicToken: string
export interface Payment { id: string; orderId: string; provider: 'razorpay'; providerRef: string; referenceId: string;
  status: 'CREATED' | 'PAID' | 'EXPIRED' | 'CANCELLED'; amountCents: number; currency: string; shortUrl: string;
  providerPaymentId: string | null; expiresAt: string; createdAt: string }
// Settings gains:
export interface PaymentSettings { onlineEnabled: boolean; codEnabled: boolean; linkExpiryMinutes: number } // defaults true, true, 1440
// InboundMessage gains: action?: string   (payload of a tapped button / list row, see 3.12)
// RealtimeEvent gains: { type: 'payment.updated'; orderId: string; number: number; paymentStatus: PaymentStatus }
```

## 3.8 Bot Replies — `src/api/src/channels/reply.ts`
```ts
export interface ReplyButton { id: string; title: string }                      // id = action (3.12), title ≤ 20 chars
export interface ReplyListRow { id: string; title: string; description?: string } // title ≤ 24, description ≤ 72
export interface BotReply {
  text: string;                                                                   // ≤ 1024 when interactive
  buttons?: ReplyButton[];                                                        // ≤ 3
  list?: { button: string; sections: { title: string; rows: ReplyListRow[] }[] }; // button ≤ 20, ≤ 10 rows total
  link?: { label: string; url: string };                                          // single URL button, label ≤ 20
}
// At most ONE of buttons | list | link. normaliseReply() truncates titles with "…" and drops overflow (never throws).
// renderPlain(reply): text + "\n\n1. Title\n2. Title…" (+ "\n<label>: <url>") for channels without rich support.
// Numbered replies ("2") map back to the option id via the last options sent to that user (stored with the outbound message).
// ChannelAdapter gains: sendReply(to: string, reply: BotReply): Promise<void>   (default: send(to, renderPlain(reply)))
// Messenger port gains: reply(channel, to, reply: BotReply): Promise<void>
```

## 3.9 WhatsApp Interactive — Cloud API `POST /{phone-number-id}/messages`
```jsonc
// buttons
{ "messaging_product": "whatsapp", "to": "<wa_id>", "type": "interactive",
  "interactive": { "type": "button", "body": { "text": "…" },
    "action": { "buttons": [ { "type": "reply", "reply": { "id": "catalog", "title": "🛍 Browse" } } ] } } }
// list
{ …, "interactive": { "type": "list", "body": { "text": "…" },
    "action": { "button": "Choose", "sections": [ { "title": "Apparel", "rows": [ { "id": "prod:<uuid>", "title": "Red T-Shirt", "description": "₹499 · 40 left" } ] } ] } } }
// URL button
{ …, "interactive": { "type": "cta_url", "body": { "text": "…" },
    "action": { "name": "cta_url", "parameters": { "display_text": "Pay ₹998", "url": "https://rzp.io/i/…" } } } }
// inbound taps (webhook messages[]):
{ "id": "wamid…", "from": "<wa_id>", "type": "interactive",
  "interactive": { "type": "button_reply", "button_reply": { "id": "catalog", "title": "🛍 Browse" } } }
{ …, "interactive": { "type": "list_reply", "list_reply": { "id": "prod:<uuid>", "title": "Red T-Shirt" } } }
// inbound template quick-reply: { "type": "button", "button": { "payload": "…", "text": "…" } }
```

## 3.10 Telegram & Messenger Rich Replies
```jsonc
// Telegram sendMessage: buttons/list → one inline button per row; link → url button
{ "chat_id": "42", "text": "…", "reply_markup": { "inline_keyboard": [[{ "text": "🛍 Browse", "callback_data": "catalog" }], [{ "text": "Pay ₹998", "url": "https://…" }]] } }
// callback_data ≤ 64 BYTES → actions must fit (uuids are 36 chars; "qty:<uuid>:10" = 43 ✓)
// inbound: update.callback_query { id, data, from: { first_name }, message: { chat: { id } } }
//   → treat as InboundMessage { action: data, text: <button text> } and POST /answerCallbackQuery { callback_query_id }
// Messenger / Instagram Send API: buttons + list rows → quick_replies (≤ 13, title ≤ 20); link → appended to text
{ "recipient": { "id": "PSID" }, "messaging_type": "RESPONSE",
  "message": { "text": "…", "quick_replies": [ { "content_type": "text", "title": "Browse", "payload": "catalog" } ] } }
// inbound: messaging[].message.quick_reply.payload  or  messaging[].postback.payload
```

## 3.11 Razorpay API — Payment Links (server-side, Basic auth key_id:key_secret)
```jsonc
// POST {RAZORPAY_API_BASE=https://api.razorpay.com}/v1/payment_links
{ "amount": 99800, "currency": "INR", "accept_partial": false, "reference_id": "ORD-42-1a2b",
  "description": "Corner Shop order #42", "customer": { "name": "Asha", "contact": "+919811112222" },
  "notify": { "sms": false, "email": false }, "reminder_enable": false,
  "notes": { "order_id": "<uuid>" }, "callback_url": "<PUBLIC_BASE_URL>/shop/order/<public_token>",
  "callback_method": "get", "expire_by": 1793999999 }
// → 200 { "id": "plink_…", "short_url": "https://rzp.io/i/…", "status": "created", "amount": 99800, "reference_id": "ORD-42-1a2b" }
// POST /v1/payment_links/{id}/cancel → { "status": "cancelled" }
// Webhook POST /webhooks/razorpay   headers: X-Razorpay-Signature = hex(HMAC_SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)), X-Razorpay-Event-Id
{ "event": "payment_link.paid",
  "payload": { "payment_link": { "entity": { "id": "plink_…", "status": "paid", "amount": 99800, "amount_paid": 99800, "reference_id": "ORD-42-1a2b" } },
               "payment": { "entity": { "id": "pay_…", "amount": 99800, "status": "captured" } } } }
// also: payment_link.expired, payment_link.cancelled (payload.payment_link.entity.id)
// Callback query (UX only, never trusted for state): razorpay_payment_id, razorpay_payment_link_id,
//   razorpay_payment_link_reference_id, razorpay_payment_link_status, razorpay_signature
//   = hex(HMAC_SHA256(`${link_id}|${reference_id}|${status}|${payment_id}`, key_secret))
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RAZORPAY_API_BASE (tests / E2E fake only)
```

## 3.12 Chat Action IDs
| Action | Meaning |
|---|---|
| `menu` | Welcome buttons: Browse · My cart · My orders |
| `catalog` | Category list (or product list if ≤ 1 category) |
| `cat:<categoryId>:<offset>` | Products in category, 9 per page + "More…" row (`all` = uncategorised/all) |
| `prod:<productId>` | Product detail + quantity list |
| `qty:<productId>:<n>` | Add n to cart → buttons Checkout · Keep shopping · Clear cart |
| `cart` · `cart:clear` · `checkout` | Show cart · empty it · checkout summary with payment buttons |
| `pay:online` · `pay:cod` | Place order from cart with that method |
| `orders` · `order:<number>` | Last 5 own orders · one order's status |
| `paylink:<number>` | (Re)send pay link for own unpaid ONLINE order |

## 3.13 Release 2 REST API
| Method & Path | Role | Body / Query | Response |
|---|---|---|---|
| POST /webhooks/razorpay | signed | Razorpay event | 200 `{ok:true}` · 401 bad signature · 503 not configured |
| POST /api/orders/:id/payment-link | staff | `{notify?: boolean}` | `{url, expiresAt}` (409 if PAID/CANCELLED, 501 if Razorpay off) |
| GET /api/payments/config | any | – | `{razorpayConfigured, onlineAvailable, codEnabled, reason?}` |
| POST /api/public/orders | public | + `paymentMethod: 'COD' \| 'ONLINE'` | + `{token, paymentUrl?}` |
| GET /api/public/orders/:token | public | – | `{number, status, paymentMethod, paymentStatus, totalCents, currency, items:[{name,quantity}]}` |
| GET /api/public/catalog | public | – | `settings` gains `paymentMethods: ('ONLINE'\|'COD')[]` |
| PUT /api/settings | admin | + `payments: PaymentSettings` | Settings |

## 3.14 Release 2 REST API — additions made during the build
| Method & Path | Role | Notes |
|---|---|---|
| POST /api/public/orders/:token/payment-link | token | Returns `{paymentUrl}`: the open link, or a fresh one after expiry. 409 unless the order is ONLINE, UNPAID and not cancelled. Rate limited (30 / 15 min) |
| POST /api/orders/:id/refunded | staff | REFUND_DUE → REFUNDED exactly once (409 otherwise). Publishes `payment.updated` and messages the chat customer |
| POST /api/orders/:id/payment-link | staff | Body `{notify?: boolean}` → `{url, expiresAt, notified}` |
| GET /api/payments/config | any | `{razorpayConfigured, onlineAvailable, codEnabled, reason?}` |
| POST /api/public/orders | public | Errors: 409 method unavailable, **429 `TOO_MANY_OPEN_ORDERS`** (15 open orders per customer, staff-entered orders exempt), 502 `PAYMENT_PROVIDER_ERROR` (the web order is cancelled again) |

Migrations: `002_reply_options.sql` (options shown with each reply), `003_payments_chat.sql` (payments, webhook events, chat carts, order payment columns), `004_refunded.sql` (REFUNDED status).
Production configuration rule (T56): `RAZORPAY_API_BASE` and `META_GRAPH_BASE` must be `https` (loopback `http` allowed for local fakes).

## 3.15 Release 3 Purchasing — `src/api/migrations/005_purchasing.sql`
All money is integer minor units. Quantities are positive integers. Stock changes only through StockService.
```sql
ALTER TABLE products ADD COLUMN reorder_quantity integer NOT NULL DEFAULT 0, ADD COLUMN preferred_supplier_id uuid REFERENCES suppliers(id);
CREATE TABLE purchase_orders (id uuid PK, number serial UNIQUE, supplier_id uuid NOT NULL REFERENCES suppliers(id),
  status text NOT NULL CHECK (status IN ('DRAFT','SENT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id), expected_date date, notes text NOT NULL DEFAULT '',
  total_cents integer NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz, updated_at timestamptz);
CREATE TABLE purchase_order_items (id uuid PK, purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id), quantity integer NOT NULL CHECK (quantity > 0),
  received_quantity integer NOT NULL DEFAULT 0 CHECK (received_quantity BETWEEN 0 AND quantity), unit_cost_cents integer NOT NULL CHECK (unit_cost_cents >= 0));
CREATE TABLE bills (id uuid PK, number serial UNIQUE, supplier_id uuid NOT NULL REFERENCES suppliers(id), purchase_order_id uuid REFERENCES purchase_orders(id),
  status text NOT NULL CHECK (status IN ('UNPAID','PARTIAL','PAID','VOID')), total_cents integer NOT NULL, paid_cents integer NOT NULL DEFAULT 0 CHECK (paid_cents <= total_cents),
  due_date date NOT NULL, created_at timestamptz);
CREATE TABLE bill_payments (id uuid PK, bill_id uuid NOT NULL REFERENCES bills(id), amount_cents integer NOT NULL CHECK (amount_cents > 0),
  request_id text NOT NULL UNIQUE, method text NOT NULL, paid_at timestamptz NOT NULL DEFAULT now());
```
| Method & Path | Role | Notes |
|---|---|---|
| GET/POST /api/purchase-orders, GET/PATCH /api/purchase-orders/:id | staff (GET: any) | PATCH only while DRAFT; totals server-side |
| POST /api/purchase-orders/:id/send, /cancel | staff | DRAFT→SENT; cancel unless something was received; else 409 |
| POST /api/purchase-orders/:id/receive | staff | `{lines:[{itemId,quantity,warehouseId?}]}`; never above ordered; ledger rows carry `reference='PO-<n>'` |
| GET/POST /api/bills, POST /api/bills/:id/payments | staff | payment body needs `requestId` (idempotent); overpay → 409 |
| GET /api/reports/payables | staff | open balance per supplier |
| GET/POST /api/reorder-suggestions | staff | POST `{productIds[]}` → one DRAFT PO per preferred supplier |

## 3.16 Release 3 Sales documents — `src/api/migrations/006_tax_discount.sql`
```sql
CREATE TABLE tax_rates (id uuid PK, name text NOT NULL UNIQUE, rate_bp integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000), active boolean NOT NULL DEFAULT true); -- basis points: 18% = 1800
ALTER TABLE products ADD COLUMN tax_rate_id uuid REFERENCES tax_rates(id);
ALTER TABLE orders ADD COLUMN discount_cents integer NOT NULL DEFAULT 0, ADD COLUMN tax_cents integer NOT NULL DEFAULT 0, ADD COLUMN subtotal_cents integer;
ALTER TABLE order_items ADD COLUMN tax_rate_bp integer NOT NULL DEFAULT 0, ADD COLUMN discount_cents integer NOT NULL DEFAULT 0;
CREATE TABLE invoices (id uuid PK, order_id uuid NOT NULL UNIQUE REFERENCES orders(id), number text NOT NULL UNIQUE, -- INV-<year>-<6 digits>, gapless per year
  status text NOT NULL CHECK (status IN ('ISSUED','VOID')), seller jsonb NOT NULL, customer jsonb NOT NULL, lines jsonb NOT NULL,
  subtotal_cents integer, discount_cents integer, tax_cents integer, total_cents integer NOT NULL, issued_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sales_returns (id uuid PK, number serial UNIQUE, order_id uuid NOT NULL REFERENCES orders(id), warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  credit_total_cents integer NOT NULL, request_id text NOT NULL UNIQUE, reason text NOT NULL DEFAULT '', created_at timestamptz);
CREATE TABLE sales_return_items (id uuid PK, sales_return_id uuid NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE, order_item_id uuid NOT NULL REFERENCES order_items(id), quantity integer NOT NULL CHECK (quantity > 0));
CREATE TABLE purchase_returns (id uuid PK, number serial UNIQUE, bill_id uuid REFERENCES bills(id), purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id), warehouse_id uuid NOT NULL REFERENCES warehouses(id), debit_total_cents integer NOT NULL, request_id text NOT NULL UNIQUE, created_at timestamptz);
```
Rounding rule: line tax = round-half-up(`(line_total − line_discount) × rate_bp / 10000`); order totals are the sum of rounded line values; there is no second rounding. Invoices are never updated; a change after issue is a credit note.

| Method & Path | Role | Notes |
|---|---|---|
| GET/POST/PATCH /api/tax-rates | admin (GET: any) | |
| GET /api/invoices, /api/invoices/:id | staff | |
| GET /api/invoices/:id/print, /api/orders/:id/packing-slip, /api/picklists?orderIds= | staff | escaped HTML, A4 print CSS |
| POST /api/orders/:id/returns | staff | `{requestId, warehouseId, lines:[{orderItemId,quantity}], reason?}`; cannot exceed shipped − already returned |
| POST /api/purchase-orders/:id/returns | staff | stock issued through StockService; cannot go negative |

## 3.17 Release 3 Tracking — `src/api/migrations/007_tracking.sql`
```sql
ALTER TABLE products ADD COLUMN barcode text UNIQUE, ADD COLUMN tracking text NOT NULL DEFAULT 'NONE' CHECK (tracking IN ('NONE','BATCH','SERIAL')), ADD COLUMN is_bundle boolean NOT NULL DEFAULT false;
CREATE TABLE bundle_components (bundle_id uuid REFERENCES products(id) ON DELETE CASCADE, component_id uuid REFERENCES products(id), quantity integer NOT NULL CHECK (quantity > 0), PRIMARY KEY (bundle_id, component_id), CHECK (bundle_id <> component_id));
CREATE TABLE stock_batches (id uuid PK, product_id uuid NOT NULL REFERENCES products(id), warehouse_id uuid NOT NULL REFERENCES warehouses(id), batch_no text NOT NULL, expires_on date, quantity integer NOT NULL CHECK (quantity >= 0), expiry_alerted boolean NOT NULL DEFAULT false, UNIQUE (product_id, warehouse_id, batch_no));
CREATE TABLE stock_serials (id uuid PK, product_id uuid NOT NULL REFERENCES products(id), serial text NOT NULL, warehouse_id uuid REFERENCES warehouses(id), status text NOT NULL CHECK (status IN ('IN_STOCK','ISSUED')), UNIQUE (product_id, serial));
```
Rules: a bundle holds no stock of its own; its availability is `min(floor(component_on_hand / quantity))`. For BATCH products Σ batch quantity = `stock_levels.quantity` per warehouse (checked in tests). Issue picks the earliest non-expired expiry first. Barcode: EAN-13 (valid check digit) or Code 128.

## 3.18 Release 3 Costing, Reports, Import, Audit — `src/api/migrations/008_costing.sql`
```sql
ALTER TABLE stock_movements ADD COLUMN unit_cost_cents integer;
ALTER TABLE stock_levels ADD COLUMN avg_cost_cents integer NOT NULL DEFAULT 0;
CREATE TABLE audit_log (id bigserial PK, at timestamptz NOT NULL DEFAULT now(), actor_id uuid, actor_email text, action text NOT NULL, entity text NOT NULL, entity_id text, before jsonb, after jsonb);
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC; -- append-only; also enforced by a trigger that raises
```
Costing: moving weighted average on receipt `new = round((old_qty×old_avg + in_qty×in_cost) / (old_qty+in_qty))`; issues use the current average and never change it.

| Method & Path | Role | Notes |
|---|---|---|
| GET /api/reports/valuation, /sales, /purchases, /margin, /movements, /low-stock, /ageing | staff | `from`,`to`,`page`,`format=csv` |
| POST /api/imports/products?dryRun=true\|false | admin | multipart CSV ≤ 2 MB / 5000 rows; dry-run writes nothing |
| GET /api/audit | admin | filter by entity, actor, date |
CSV safety: cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`.

## 3.19 Release 3 Retail experience and QR — `src/api/migrations/009_retail.sql`
Ideas taken from public descriptions of DMart Ready (price vs MRP, delivery or pick-up point, time slots, minimum order, repeat orders). Details of the real app were not verifiable, so only the generic pattern is used.
```sql
ALTER TABLE products ADD COLUMN mrp_cents integer CHECK (mrp_cents IS NULL OR mrp_cents >= price_cents);
ALTER TABLE orders ADD COLUMN fulfilment text NOT NULL DEFAULT 'PICKUP' CHECK (fulfilment IN ('PICKUP','DELIVERY')),
  ADD COLUMN delivery_fee_cents integer NOT NULL DEFAULT 0, ADD COLUMN delivery_pincode text, ADD COLUMN slot_id uuid REFERENCES delivery_slots(id),
  ADD COLUMN handover_code text UNIQUE, ADD COLUMN handed_over_at timestamptz;
CREATE TABLE delivery_slots (id uuid PK, kind text NOT NULL CHECK (kind IN ('PICKUP','DELIVERY')), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK (ends_at > starts_at), capacity integer NOT NULL CHECK (capacity > 0), booked integer NOT NULL DEFAULT 0 CHECK (booked BETWEEN 0 AND capacity));
CREATE TABLE service_pincodes (pincode text PRIMARY KEY CHECK (pincode ~ '^[1-9][0-9]{5}$'));
```
Settings keys added: `minOrderCents`, `deliveryFeeCents`. Slot booking: `UPDATE delivery_slots SET booked = booked + 1 WHERE id = $1 AND booked < capacity` (atomic); cancellation decrements once.
`handover_code` is 128-bit random (base64url), shown only to the owning customer; scanning marks `handed_over_at` exactly once.

| Method & Path | Role | Notes |
|---|---|---|
| GET /api/public/slots?kind=&pincode= | public | only slots with space, rate limited |
| GET/POST/PATCH /api/slots, GET/PUT /api/service-pincodes | admin (GET: staff) | |
| POST /api/public/orders/:token/repeat | token | builds a cart preview; nothing is ordered until confirmed |
| GET /api/products/:id/qr.svg, /api/shop/qr.svg, /api/shop/whatsapp-qr.svg | staff / public for shop | fixed targets only; no free-text QR endpoint |
| POST /api/orders/handover | staff | `{code}`; 404 unknown, 409 reused or cancelled |
| POST /api/counter-sales, GET /api/counter-sales/:id | staff | creates order + Razorpay UPI QR |

Razorpay UPI QR (verify against test keys before enabling): `POST /v1/payments/qr_codes` with `type: "upi_qr"`, `usage: "single_use"`, `fixed_amount: true`, `payment_amount` (paise), `close_by`; paid state arrives on the signed `qr_code.credited` webhook. Razorpay's pages describe two creation paths and a note about webhooks on close; contract tests pin what we implement and the feature flag stays off until a real test run confirms it.
