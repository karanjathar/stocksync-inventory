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

# Release 3 contracts (reliable messaging & operations)

## 3.15 Release 3 Database — `src/api/migrations/005_outbox_jobs.sql`
```sql
ALTER TABLE channel_messages
  ADD COLUMN IF NOT EXISTS payload jsonb,            -- rendered BotReply / template, needed to retry
  ADD COLUMN IF NOT EXISTS provider_message_id text, -- wamid / telegram message_id
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_code text, ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS status_at timestamptz,
  ADD COLUMN IF NOT EXISTS event text;               -- notification event (order_confirmed …) or NULL for bot replies
-- status: in = 'ok'; out = queued | sent | delivered | read | failed | skipped   ('ok' kept as a legacy alias of sent)
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_provider_id ON channel_messages(channel, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_out_status ON channel_messages(status) WHERE direction = 'out';

CREATE TABLE IF NOT EXISTS jobs (id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text, run_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 6,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
  locked_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_dedupe ON jobs(kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(run_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS worker_heartbeats (worker_id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS maintenance_runs (task text PRIMARY KEY, ran_at timestamptz NOT NULL, result jsonb NOT NULL);
```
Claiming: `UPDATE jobs SET status='running', attempts=attempts+1, locked_until=now()+interval '5 minutes' WHERE id IN
(SELECT id FROM jobs WHERE status='pending' AND run_at<=now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING *`.
A `running` job whose `locked_until` passed is reclaimed. Backoff: `min(2^attempts · 30 s, 30 min) ± 20 %` jitter.

## 3.16 Job kinds — `src/api/src/jobs/`
| kind | payload | handler |
|---|---|---|
| `message.send` | `{ messageId }` | send the stored message; classify the error as retryable/permanent |
| `maintenance.expireUnpaid` | `{}` | hourly, dedupe key = hour |
| `maintenance.prune` | `{}` | daily: webhook_events > 30 d, chat > `chatRetentionDays` |

`JobQueue`: `enqueue(kind, payload, { runAt?, dedupeKey?, maxAttempts? })`, `start({ concurrency, pollMs })`, `stop()` (drain).
Handlers throw `PermanentJobError` to stop retrying.

## 3.17 Release 3 Settings & Types
```ts
type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
type NotificationEvent = 'order_confirmed' | 'order_cancelled' | 'order_fulfilled' | 'payment_received'
  | 'payment_link' | 'refund_due' | 'refunded' | 'low_stock_alert';
interface Settings { /* … */
  whatsappTemplates: Partial<Record<NotificationEvent, { name: string; language: string; params: string[] }>>; // params: ordered placeholders e.g. ["orderNumber","total"]
  maintenance: { unpaidOrderTtlHours: number /* 1–720, default 48 */; chatRetentionDays: number /* 0–3650, default 365 */ };
}
```
WhatsApp template send (Cloud API): `{ messaging_product:"whatsapp", to, type:"template", template:{ name, language:{ code },
components:[{ type:"body", parameters:[{ type:"text", text }] }] } }`.
WhatsApp status webhook: `entry[].changes[].value.statuses[] = { id, status, timestamp, recipient_id, errors?: [{ code, title }] }`.
24-hour window: last inbound `channel_messages.created_at` for (`whatsapp`, user) within 24 h.

## 3.18 Release 3 REST API
| Method & path | Role | Notes |
|---|---|---|
| `GET /readyz` | public | 200 `{db:true, migrations:true, worker:true}` or 503 with the failing checks |
| `GET /api/ops/status` | admin | `{ queue:{pending, running, dead, oldestPendingSec}, messages:{failed24h, queued}, maintenance:[{task, ranAt, result}] }` |
| `POST /api/messages/:id/retry` | staff | only `failed` outbound messages → `queued` + job; 409 otherwise |
| `PATCH /api/settings` | admin | accepts `whatsappTemplates`, `maintenance` |

# Release 4 contracts (procurement, GST, barcode, refunds)

## 3.19 Release 4 Database (migrations 006–009)
```sql
-- 006_purchase_orders.sql
CREATE TABLE purchase_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number serial UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id), warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  notes text NOT NULL DEFAULT '', created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE purchase_order_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id), quantity int NOT NULL CHECK (quantity > 0), received_quantity int NOT NULL DEFAULT 0,
  unit_cost_cents int NOT NULL CHECK (unit_cost_cents >= 0), CHECK (received_quantity <= quantity), UNIQUE (po_id, product_id));
CREATE TABLE purchase_receipts (receipt_id text NOT NULL, po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (po_id, receipt_id));   -- idempotency of a receive call
-- 007_gst_invoices.sql
ALTER TABLE products ADD COLUMN hsn_code text, ADD COLUMN gst_rate_bp int NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 2800);
ALTER TABLE customers ADD COLUMN gstin text, ADD COLUMN state_code text;                 -- 2-digit GST state code
CREATE TABLE invoice_counters (fy text PRIMARY KEY, last_number int NOT NULL);           -- fy like '2026-27'
CREATE TABLE invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  fy text NOT NULL, seq int NOT NULL, number text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','VOID')),
  issued_at timestamptz NOT NULL DEFAULT now(), snapshot jsonb NOT NULL, taxable_cents int NOT NULL, tax_cents int NOT NULL, total_cents int NOT NULL,
  UNIQUE (fy, seq));
-- 008_barcodes_counts.sql
ALTER TABLE products ADD COLUMN barcode text; CREATE UNIQUE INDEX uq_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE TABLE stock_counts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number serial UNIQUE, warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SUBMITTED','CANCELLED')), created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz);
CREATE TABLE stock_count_lines (count_id uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id),
  counted_quantity int NOT NULL CHECK (counted_quantity >= 0), system_quantity int, PRIMARY KEY (count_id, product_id));
-- 009_refunds.sql
ALTER TABLE payments ADD COLUMN provider_payment_id text, ADD COLUMN refund_id text, ADD COLUMN refund_status text CHECK (refund_status IN ('PENDING','PROCESSED','FAILED'));
```
Settings additions: `gst: { legalName, gstin, address, stateCode, invoicePrefix: 'INV', pricesIncludeTax: true }`.

## 3.20 GST computation (pure function `computeInvoice`, integer paise)
Per line: `gross = unitPrice × qty`. Inclusive prices: `taxable = round(gross × 10000 / (10000 + rateBp))`, `tax = gross − taxable`. Exclusive: `taxable = gross`, `tax = round(gross × rateBp / 10000)`. Same state (buyer state = seller state, or buyer has none): `cgst = floor(tax/2)`, `sgst = tax − cgst`; otherwise `igst = tax`. Invoice totals are the sums of the line values, so they reconcile exactly. Rounding is half-up (`Math.round` on non-negative integers).
Number: `${prefix}/${fy}/${seq padded to 6}`; the financial year runs 1 April–31 March in India (Asia/Kolkata). The counter row is locked with `SELECT … FOR UPDATE` inside the issuing transaction so numbers are gapless.

## 3.21 Release 4 REST API
| Method & path | Role | Notes |
|---|---|---|
| `GET/POST /api/purchase-orders`, `GET /:id`, `PATCH /:id` (draft only) | staff (GET viewer) | create/edit DRAFT |
| `POST /api/purchase-orders/:id/send` · `/cancel` | staff | DRAFT→SENT; cancel refused after any receipt |
| `POST /api/purchase-orders/:id/receive` | staff | `{ receiptId, lines:[{productId, quantity}] }`, idempotent on receiptId |
| `GET /api/reorder-suggestions` · `POST /api/reorder-suggestions/create-pos` | viewer / staff | one DRAFT PO per supplier |
| `GET /api/orders/:id/invoice` (JSON) · `/invoice.pdf` | staff | issues the invoice if the order is CONFIRMED/FULFILLED and none exists |
| `GET /api/public/orders/:token/invoice.pdf` | token | only when the order is confirmed or fulfilled |
| `GET /api/products/by-barcode/:code` | viewer | 404 when unknown |
| `POST/GET /api/stock-counts`, `PUT /:id/lines`, `POST /:id/submit` · `/cancel` | staff | submit applies variances via StockService.adjust |
| `POST /api/orders/:id/refund` | staff | REFUND_DUE only; amount = captured payment amount |
Razorpay refund: `POST /v1/payments/{payment_id}/refund` body `{ amount, speed:'normal', receipt, notes }`, Basic auth; webhook events `refund.processed`, `refund.failed` carry `payload.refund.entity { id, payment_id, amount, status }`.

# Release 5 contracts (tenancy, billing, AI)

## 3.22 Tenancy
```sql
-- 010: tenants, tenant_id everywhere, per-tenant uniqueness, RLS
CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text NOT NULL, status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETING')), plan text NOT NULL DEFAULT 'FREE',
  created_at timestamptz NOT NULL DEFAULT now());
-- Every business table gets: tenant_id uuid NOT NULL REFERENCES tenants(id), backfilled to the single existing tenant, plus an index on tenant_id.
-- Uniques become (tenant_id, …): sku, barcode, warehouse code, category name, customer (channel, channel_user_id), settings key, invoice (fy, seq), invoice_counters fy.
-- Human numbers (orders, POs, counts) come from tenant_counters(tenant_id, kind, last_number) instead of global serials.
CREATE POLICY tenant_isolation ON <table> USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY; ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
```
The app connects as role `stocksync_app` (not the table owner, no BYPASSRLS); migrations run as the owner. Context: an `AsyncLocalStorage` holds the tenant id; the pool wrapper issues `set_config('app.tenant_id', $1, false)` on checkout and resets it on release, so every existing service keeps its `pool.query` calls. Platform tables (`tenants`, `platform_admins`, `plans`) are outside RLS and reachable only from platform routes.

## 3.23 Channels and secrets
`tenant_channels(tenant_id, kind, config_encrypted bytea, key_version int, updated_at)`; `kind` in whatsapp|messenger|instagram|telegram|razorpay. Envelope: AES-256-GCM, 96-bit random nonce, tenant id as associated data (a ciphertext copied to another tenant fails to decrypt). Webhook routes: `POST /webhooks/meta` (resolved by `phone_number_id` / page id from the payload, then verified with that tenant's app secret), `POST /webhooks/razorpay/:tenantId`, `POST /webhooks/telegram/:tenantId`.

## 3.24 Plans, usage, billing
`plans(code, name, price_cents, limits jsonb)`, `usage_counters(tenant_id, period, metric, value)`, `subscriptions(tenant_id, razorpay_subscription_id, status, plan, current_end, grace_until)`. Limits keys: products, users, chatMessagesPerMonth, invoicesPerMonth. Errors: HTTP 402 `PLAN_LIMIT` with `{limit, used, plan}`.

## 3.25 AI
Anthropic Messages API with tool use (injectable fetch, model from env). Tools for ordering: `search_products(query)`, `add_to_cart(productId, quantity)`, `show_cart()`; a checkout always returns a confirmation button action id. Staff assistant tools are read-only. `ai_usage(tenant_id, month, input_tokens, output_tokens, cost_micro_usd)`; a hard budget per tenant per month; `ai_enabled` kill switch per tenant and globally. Logs store sizes and tool names, never message content.

## 3.26 Sign-up (migration 018)
`signup_requests` (email UNIQUE, slug UNIQUE, business_name, owner_name, password_hash, token_hash UNIQUE = SHA-256 of the emailed token, expires_at 24 h, send_count, last_sent_at). No grants to the application role; reached only through SECURITY DEFINER `signup_begin` / `signup_resend` / `signup_complete`. `signup_complete` creates the tenant, its admin user and the `businessName` setting in one transaction and deletes the request (single use). API: `POST /api/signup` and `/resend` answer 202 with one fixed body for new, existing and throttled emails; `POST /api/signup/verify` → 201 `{slug}` or one plain 400. Limits: 1 send per 60 s and 5 per request in the database, plus per-IP and per-email HTTP limiters.

## 3.27 Onboarding and sample data (T97)
No new tables. Per-business state lives in `settings` rows (already tenant-scoped): `onboardingDismissed` (boolean) and `demoData` (ids of the sample records). `GET /api/onboarding` (admin) returns the checklist computed from real data (`profile`, `warehouse`, `product`, `whatsapp`, optional `gst`; sample records never count), `dismissed`, `demo`, `complete`. `POST /api/onboarding/dismiss {dismissed}`; `POST /api/onboarding/demo` (201 created / 200 already there; idempotent) adds a `DEMO` warehouse, `[Demo]` category, supplier and six `DEMO-*` products with stock received through StockService; `DELETE /api/onboarding/demo` removes them, hiding (is_active=false) any sample product that real orders already reference.

## 3.28 Plans, limits and usage (migration 019, T98)
`plans` (code PK, name, price_minor integer paise/month, currency, max_products, max_users, max_chat_messages, max_invoices — NULL = unlimited, sort, active); seeded FREE (50 products, 2 users, 200 messages, 20 invoices/month), PRO (₹999: 2000 / 10 / 5000 / 500) and BUSINESS (₹2,999, unlimited). `tenants.plan` references it; the pre-tenancy default business is BUSINESS. The application role may only SELECT plans; the platform role edits them (`PUT /api/platform/plans/:code`, `PATCH /api/platform/tenants/:id {plan}`), so prices and limits change without a deploy. `usage_counters (tenant_id, metric, period 'YYYY-MM', used)` with RLS; `PlansService.consume` is one conditional upsert (`… DO UPDATE … WHERE used < limit`), so concurrent callers cannot overshoot. Products and users are counted live (check-then-insert: concurrent creates may overshoot by the number of in-flight requests; accepted). Enforcement: products/users routes and invoice issue return **402 PLAN_LIMIT** `{metric, limit, used, plan}`; an over-limit outgoing chat message is stored as `failed` with error code PLAN_LIMIT and never sent. Nothing is ever deleted; a downgrade keeps all data and only blocks new records. `GET /api/usage` (admin), `GET /api/public/plans`.

## 3.29 Billing with Razorpay Subscriptions (migration 020, T99)
Platform Razorpay account (env `RAZORPAY_PLATFORM_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`, `BILLING_TRIAL_DAYS`=14, `BILLING_GRACE_DAYS`=7), separate from any business's own payment keys. `plans.razorpay_plan_id` is set by the operator (`PUT /api/platform/plans/:code {razorpayPlanId}`); the amount lives in Razorpay's plan and no amount or plan id is ever accepted from a business. `subscriptions` (one per business): status CREATED → TRIAL → ACTIVE ⇄ PAST_DUE → EXPIRED / CANCELLED; the app role can only SELECT it. The business-side API (`/api/billing`, admin: GET, POST subscribe|change|cancel) calls Razorpay and records the request through two SECURITY DEFINER functions (`billing_register`, `billing_note_request`) that never set a paid state. State changes **only** from `POST /webhooks/razorpay-billing` (HMAC over the raw body, timing-safe, idempotent per `x-razorpay-event-id` via `billing_events`, applied in one transaction on the platform role): authenticated→TRIAL (paid plan unlocked), activated/charged/resumed→ACTIVE (plan from the matched Razorpay plan id), pending/halted→PAST_DUE with a grace period that is never extended, cancelled/completed→Free. `BillingWebhooks.expireGrace` (every 10 min) moves unpaid businesses to Free and keeps all their data. One trial per business. Unverified against live Razorpay (no credentials); event payload shapes follow Razorpay's documented subscription.* events.

## 3.30 Audit trail and platform console (migration 021, T100)
`audit_log` (tenant_id, at, actor_id, actor, action, entity, entity_id, detail jsonb, ip) with RLS. The application role has SELECT and INSERT only (no UPDATE/DELETE/TRUNCATE), so entries are append-only even against injected SQL; the platform role has INSERT only (it writes its own plan/suspend changes as `platform:<email>`, and cannot read any entry). Every successful non-GET request of a signed-in user is recorded by `auditTrail` middleware after the response (`METHOD /route`, entity id, field names, and the values of a short allow-list such as priceCents, role, quantity, plan — never passwords, tokens or free text). Best effort: a crash between the response and the write loses that one line (logged on failure). `GET /api/audit-log` (admin; limit ≤ 200, `before` cursor, `action`/`actor` filters); web "Activity log". Platform console `GET /api/platform/tenants` returns each business with plan, subscription state and this month's metered usage (counters only) via a read policy on `usage_counters`; web `/platform` has its own sign-in and keeps the token in memory.

## 3.31 Data rights (migration 022, T101)
`POST /api/data/export` (admin; POST so it is audited): a streamed zip (fflate) with one CSV per table of the business, `manifest.json` (row counts) and `README.txt`. Tables are discovered from the catalogue (every table with `tenant_id`), so new tables are exported automatically; excluded: `users.password_hash`, `tenant_channels` (encrypted credentials), `jobs`, `webhook_events`, `subscriptions`, `deletion_requests`, `tenant_counters`. Rows are read through a server-side cursor in batches of 500 inside one REPEATABLE READ READ ONLY snapshot and compressed as they arrive, honouring back-pressure (memory stays bounded). Cells starting with `= + - @` are prefixed with an apostrophe (CSV injection).
`deletion_requests` (one per business): `POST /api/data/deletion {password, confirmSlug}` (re-authenticates the admin) starts a 30-day hold; asking again keeps the original clock; `DELETE` cancels. After the hold `TenantEraser` (platform role, every 30 min) calls `tenant_erase(tenant)` — a SECURITY DEFINER function executable only by the platform role, which refuses unless a due, uncancelled request exists, never erases the original default business, discovers all `tenant_id` tables, deletes them in dependency order over repeated passes, removes the tenant row (rolling everything back if anything remains) and writes a data-free line to `tenant_deletions`. The business's image blobs (prefix = its id) are removed afterwards, best effort and not exercised against live storage.
`POST /api/data/customers/:id/erase` (admin, idempotent): customer name, phone, email, channel id, GSTIN and state are cleared (`erased_at` set), order notes blanked, saved cart deleted, chat messages with that phone/id replaced by `[erased]`. Orders, payments and stock history keep their amounts. Issued GST invoices keep their buyer snapshot because tax law requires it (documented retention exception).

## 3.32 Realtime across replicas (migration 023, T102)
`EventBus.publish` delivers to local SSE clients at once and hands `(tenantId, event)` to a transport. `PgBus` sends it with `pg_notify('stocksync_events', {o: replica id, t: tenant id, e: event})` and every other replica's LISTEN connection delivers it to its own subscribers of that business only (own notifications are ignored, so nothing is delivered twice). Payloads over 7000 bytes (NOTIFY's limit is 8000) are stored in `realtime_payloads` (tenant-scoped, RLS) and sent as `{ref}`; the receiver reads the row inside the named business's context, so a forged tenant id finds nothing. Senders prune their own references older than 5 minutes. The listener reconnects with backoff (events during a gap are not replayed; clients refetch). Uses `DATABASE_APP_URL` or `DATABASE_URL` for the LISTEN connection (it reads no data).

## 3.33 Browser sessions, CSRF and refresh rotation (migration 024, T104)
`POST /api/auth/login` sets three cookies: `ss_access` (JWT, 15 min, httpOnly, Path=/api), `ss_refresh` (opaque `<tenant id>.<random>`, 30 days, httpOnly, Path=/api/auth) and `ss_csrf` (readable by script, same lifetime as the session); all `SameSite=Strict`, and `Secure` whenever `PUBLIC_BASE_URL` is https. The body still returns `{token, user}` so API clients can keep using `Authorization: Bearer`; the web app ignores the token and stores nothing in localStorage. `refresh_tokens` (RLS) holds only SHA-256 hashes: every login starts a new family (never continuing anything the browser sent: no session fixation); `POST /api/auth/refresh` consumes a token and issues the next one in the same family (the family keeps its original end date); presenting a used token revokes the whole family and answers the same plain 401 as an unknown token. CSRF: a cookie-authenticated request that is not GET/HEAD/OPTIONS must send `x-csrf-token` = `<random>.<HMAC(random, session family)>`, so a token planted by a sibling domain or copied from another session fails; bearer requests need none. The access token carries its session id: `POST /api/auth/logout` ends that session at once, `POST /api/auth/logout-all` and a password change set `users.sessions_valid_after`, voiding every earlier access, cookie and bearer token (checked against each token's `at` claim). Concurrent refreshes from two tabs would look like a replay: the web client single-flights refresh within a tab; across tabs a rare forced re-login is accepted. Invoices: `POST /api/orders/:id/invoice[.pdf]` issues; `GET` only reads an existing invoice (no state change on GET).

## 3.34 Rate limits, lockout and observability (migration 025, T105)
`plans.requests_per_minute` (FREE 120, PRO 600, BUSINESS 3000; 10–100000; operator-editable via `PUT /api/platform/plans/:code`) is the budget of the whole BUSINESS on the signed-in API: one in-memory counter per tenant id (not per address or user), looked up from the plan and cached 30 s, answering 429 `RATE_LIMITED` with `RateLimit` headers. Counters are per replica, so a business can reach limit × replicas per minute; the per-address limiter in front still protects unauthenticated routes. `login_attempts (key, failures, last_failure_at, locked_until)` holds hashed account keys (SHA-256 of the typed email, existing account or not) and client-address keys: 5 failures lock an account, 20 an address, for 30 s doubling to 15 min; failures older than 15 min are forgotten; a success clears the account. The check runs before the password is evaluated (a correct password does not pass while locked) and answers 429 `TOO_MANY_ATTEMPTS` with `Retry-After`; it is identical for emails that have no account. Logs: a pino mixin adds `tenantId` to every line written inside a business's context; request lines include it; `tenantTelemetry` adds it to Application Insights telemetry; refused webhooks log `webhook rejected` (kind only); the worker logs `queue health` every minute. `infra/main.bicep` adds a 5xx metric alert and two log alerts (queue age > 5 min, > 20 rejected webhooks in 15 min) with an optional e-mail action group — uncompiled until `az bicep build` is available.

## 3.35 AI foundation (migration 026, T106)
Env: `ANTHROPIC_API_KEY` (optional: without it every AI feature is off), `AI_MODEL` (default `claude-haiku-5-5`), `AI_API_BASE` (https required in production), `AI_DISABLED=true` (global kill switch), `AI_TIMEOUT_MS`. `AnthropicClient` calls `POST /v1/messages` (headers `x-api-key`, `anthropic-version: 2023-06-01`) through an injectable fetch with a per-attempt timeout, up to 3 attempts with jittered exponential backoff honouring `retry-after` on 408/409/429/5xx/529 and network errors; any text taken from an API error has the key scrubbed. `AiGateway.run` (the only way the app calls the model) refuses when AI is off (global, or `tenants.ai_enabled=false` set by the operator via `PATCH /api/platform/tenants/:id {aiEnabled}`) or unconfigured, then reserves the call's worst-case cost in `ai_usage` BEFORE calling (one conditional upsert, so concurrent calls cannot overshoot `plans.ai_monthly_units`), settles the real tokens afterwards, and releases the reservation if the call fails. A unit is an input token or 5 output tokens (cost-proportional whatever the model). Over the allowance: 402 `AI_BUDGET` with limit/used/plan; a plan with 0 never calls out (defaults FREE 50k, PRO 2M, BUSINESS 20M units/month; operator-editable via `PUT /api/platform/plans/:code {aiMonthlyUnits}`). Prompts are frozen, versioned constants (`ai/prompts.ts`, ids like `ping@1`, all starting with the untrusted-input rules); logs contain `prompt` id, model, token counts, message count and tool NAMES only — never prompt or message text, results or the key.

## 3.36 AI ordering agent (T107)
Free-text chat messages that are not a known command (`catalog`, `stock`, `price`, `order`, `status`, multi-line orders) go to `OrderingAgent` (prompt `order-agent@1`) when AI is configured, on for the business and within budget; otherwise, and on any AI error, the normal welcome/tap menu is shown. The model sees five tools only: `search_products(query)`, `add_to_cart(sku, quantity 1–100)`, `show_cart()`, `offer_choices(skus 2–8)` (ends the turn with a WhatsApp/Telegram tap list of `prod:<id>` rows — ambiguity is never guessed) and `checkout()` (ends the turn with the existing checkout screen: payment buttons only). There is no tool that places an order: an order exists only after the customer taps `pay:cod` / `pay:online`. Every tool is bound in code to the sender's own customer record (resolved from the channel identity) and the business's catalogue; the model supplies a sku and a quantity, never a customer, price or shop id; arguments are strict (extra fields, bad or absurd quantities, unknown tools and other shops' skus are refused and the refusal is returned to the model). Customer text is a `user` message only (cut to 500 characters) — the system prompt and tool list are fixed constants; tool results (including product names) are `tool_result` data. Up to 6 earlier messages with that person are replayed as conversation. At most 5 model steps per message. Prices in tool results come from the shop's records, formatted server-side.
