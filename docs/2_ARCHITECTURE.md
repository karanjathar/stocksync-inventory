# 2. Architecture

## 2.1 Tech Stack
| Layer | Choice |
|---|---|
| Runtime | Node.js 22, TypeScript (strict) |
| API | Express 5, zod validation, helmet, cors, express-rate-limit, pino logging |
| Auth | JWT (HS256, `jsonwebtoken`), bcryptjs |
| DB | PostgreSQL 16 via `pg` (Azure Database for PostgreSQL Flexible Server) |
| Realtime | Server-Sent Events over authenticated fetch streaming |
| Web | React 19, Vite, React Router, PWA manifest + service worker |
| Files | Azure Blob Storage (`@azure/storage-blob`, SAS upload) |
| Messaging | WhatsApp Cloud API, Messenger and Instagram (Meta Graph API), Telegram Bot API |
| Tests | Vitest, Supertest (API, against real Postgres), Testing Library (web) |
| Infra | Docker, Azure Container Apps, ACR, Key Vault, App Insights, Bicep, GitHub Actions |

## 2.2 Topology
```
 Browser (dashboard / PWA / shop) ──HTTPS──► Azure Container App (Express API + static web)
 WhatsApp/Messenger/IG ──webhook──► /webhooks/meta      │──► Azure PostgreSQL Flexible
 Telegram ──webhook──► /webhooks/telegram               │──► Azure Blob Storage (images)
 API ──Graph API / Bot API──► chat platforms             │──► Key Vault (secrets) / App Insights
```
A single container serves both the API (`/api`, `/webhooks`) and the built SPA. It runs as 1 replica
because the SSE event bus is in-process. The upgrade path for scale-out is Azure Web PubSub.

## 2.3 Directory Layout (npm workspaces)
```
src/
  api/                       @stocksync/api
    migrations/*.sql         ordered SQL migrations (run at startup)
    src/config/env.ts        typed, validated env
    src/db/                  pg pool, tx helper, migrator
    src/domain/              shared types + errors
    src/repositories/        SQL data access, one file per aggregate
    src/services/            business logic (auth, inventory, orders, alerts, bot, settings)
    src/channels/            channel adapters (whatsapp, messenger, instagram, telegram) + hub
    src/realtime/            event bus + SSE handler
    src/storage/             Azure Blob SAS service
    src/http/                app factory, middleware, routes
    src/index.ts             composition root
    tests/                   vitest + supertest integration tests
  web/                       @stocksync/web (React SPA)
    src/api/                 typed client + SSE stream
    src/pages/               Dashboard, Products, Inventory, Orders, Inbox, Settings, Shop...
    src/components/
infra/main.bicep             Azure resources
```

## 2.4 Design Patterns
- Composition root with dependency injection (`createApp(deps)`), so tests swap in fake channels.
- Repository + service layers. HTTP handlers stay thin.
- Atomic stock change: `UPDATE stock_levels SET quantity = quantity + $d WHERE ... AND quantity + $d >= 0`
  inside a transaction with a ledger insert.
- Channel adapter interface `{ name, isConfigured(), send(to, text) }` with a `ChannelHub`.
- Domain errors (`NotFound`, `Conflict`, `Validation`, `Forbidden`) map to HTTP codes in one middleware.

## 2.5 Environment Variable Keys
See `.env.example`: NODE_ENV, PORT, CORS_ORIGINS, PUBLIC_BASE_URL, DATABASE_URL, DATABASE_SSL,
JWT_SECRET, JWT_EXPIRES_IN, ADMIN_EMAIL, ADMIN_PASSWORD, AZURE_STORAGE_CONNECTION_STRING,
AZURE_STORAGE_CONTAINER, APPLICATIONINSIGHTS_CONNECTION_STRING, META_APP_SECRET, META_VERIFY_TOKEN,
META_GRAPH_VERSION, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, MESSENGER_PAGE_TOKEN,
INSTAGRAM_PAGE_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET.
Tests use `TEST_DATABASE_URL` (default `postgres://postgres@localhost:5432/inventory_test`).

## 2.6 Commands
- Install: `npm install`
- Dev: `npm run dev` (API on :8080, Vite on :5173 proxying /api)
- **TEST_COMMAND**: `npm run typecheck && npm run lint && npm test`
- Build: `npm run build`

## 2.7 TARGET_DEPLOYMENT
Docker image → Azure Container Registry → **Azure Container Apps**. Uses Azure Database for
PostgreSQL Flexible Server, Azure Blob Storage, Azure Key Vault (secrets via managed identity),
and Azure Application Insights + Log Analytics. Provisioned with `infra/main.bicep`. CI/CD runs on
GitHub Actions with Azure OIDC federated credentials.

---
## 2.8 Release 2 additions (payments & tap-to-order)
```
WhatsApp/Telegram/Messenger tap ─► /webhooks/* ─► parse (action ids) ─► InboxService ─► ChatFlow (menu·catalog·cart·checkout·orders)
                                                                          │                  └─► ChatCartsRepo (chat_carts)
                                                                          └─► BotReply ─► ChannelHub.reply ─► adapter renders buttons/list/url (or numbered text)
Checkout (chat or web, ONLINE) ─► PaymentService ─► RazorpayClient POST /v1/payment_links ─► short_url ─► customer pays (UPI/card)
Razorpay ─► POST /webhooks/razorpay (HMAC, event-id idempotent) ─► payment PAID ─► OrdersService.confirm (stock) ─► notify customer + SSE
                                                                                  └─ confirm fails ─► REFUND_DUE + staff alert
```
- New modules: `channels/reply.ts`, `services/chatFlow.ts`, `repositories/chatCarts.ts`, `payments/razorpay.ts`, `services/payments.ts`, `http/routes/payments.ts`, web `pages/ShopOrder.tsx`.
- New env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_API_BASE` (tests/E2E only). In Azure they are Key Vault secrets via the Bicep `channelSecrets` mechanism.
- Online payments require shop currency `INR` (Razorpay Payment Links). Otherwise the online option is hidden and `GET /api/payments/config` explains why.
- Decisions: `docs/8_DECISIONS.md` D-001…D-008.
