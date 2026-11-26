# StockSync — Deployment Guide (Microsoft Azure)

```
GitHub (push to main) ──► Actions: lint · type-check · tests (PostgreSQL) · build · Bicep validate
                               └──► OIDC login ─► docker build ─► Azure Container Registry ─► Container Apps revision ─► /healthz smoke test

Azure resource group
 ├─ Container Apps environment ─ stocksync-app (API + web + shop, HTTPS ingress, probes on /healthz)
 │     └─ user-assigned managed identity ──► AcrPull on ACR · Key Vault Secrets User on Key Vault
 ├─ Azure Database for PostgreSQL Flexible Server 16 (TLS required)
 ├─ Storage account ─ blob container "product-images" (public read, CORS for direct browser upload)
 ├─ Key Vault (RBAC, soft delete, purge protection) ─ every runtime secret
 └─ Log Analytics + Application Insights (requests, dependencies, exceptions, live metrics)
```

> The spec template suggested a single `DEPLOY_CREDENTIALS` GitHub secret. This pipeline uses **OIDC workload identity federation** instead. GitHub gets a short-lived Azure token per run, so no long-lived cloud credentials sit in GitHub. `DATABASE_URL`, `PORT` and the other runtime settings live in **Key Vault / the Container App**, never in GitHub.

---

## 1. Prerequisites
- Azure subscription where you can create resources and role assignments (Owner, or Contributor + User Access Administrator)
- Azure CLI ≥ 2.60 (`az bicep install`), and a GitHub repository containing this project
- Bash (the commands below; on Windows use WSL or Git Bash)

```bash
az login
az account set --subscription "<SUBSCRIPTION_ID>"
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.DBforPostgreSQL
az provider register --namespace Microsoft.OperationalInsights
```

## 2. One-time provisioning

### 2.1 Choose names and generate secrets
```bash
export RG=stocksync-prod
export LOCATION=centralindia            # any region with Container Apps + PostgreSQL Flexible Server
export ADMIN_EMAIL=you@yourcompany.com
export PG_PASSWORD="$(openssl rand -base64 24)"
export JWT_SECRET="$(openssl rand -base64 48)"
export ADMIN_PASSWORD="$(openssl rand -base64 18)"
echo "First login password: $ADMIN_PASSWORD"    # store it in your password manager
az group create -n "$RG" -l "$LOCATION"
```

### 2.2 Phase 1: infrastructure (no app yet)
```bash
az deployment group create -g "$RG" -f infra/main.bicep \
  -p deployApp=false adminEmail="$ADMIN_EMAIL" \
     postgresAdminPassword="$PG_PASSWORD" jwtSecret="$JWT_SECRET" adminPassword="$ADMIN_PASSWORD"

export ACR_NAME=$(az deployment group show -g "$RG" -n main --query properties.outputs.acrName.value -o tsv)
```

### 2.3 First image (built inside Azure, no local Docker needed)
```bash
az acr build -r "$ACR_NAME" -t stocksync:initial .
```

### 2.4 Phase 2: create the Container App
Re-run the same deployment with the app enabled. Re-running is safe: Bicep deployments are idempotent.
```bash
az deployment group create -g "$RG" -f infra/main.bicep \
  -p deployApp=true imageTag=stocksync:initial adminEmail="$ADMIN_EMAIL" \
     postgresAdminPassword="$PG_PASSWORD" jwtSecret="$JWT_SECRET" adminPassword="$ADMIN_PASSWORD"

export APP_URL=$(az deployment group show -g "$RG" -n main --query properties.outputs.appUrl.value -o tsv)
echo "$APP_URL"
```
On first start the app runs database migrations, creates the admin user and ensures the blob container exists.

## 3. Health check verification
```bash
curl -fsS "$APP_URL/healthz"            # → {"status":"ok","db":"ok"}
curl -fsS "$APP_URL/api/public/catalog" # → {"settings":{...},"products":[]}
```
Then in a browser:
1. Open `$APP_URL`, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then go to **My account → Change password** (top right).
2. **Warehouses** → create e.g. `MAIN`. **Settings** → set it as the default warehouse, plus business name, currency and WhatsApp number.
3. **Products** → add a product with an image (this checks Blob upload). **Inventory** → Receive stock.
4. Open `$APP_URL/shop` and confirm the product, its image and the cart work.
5. On a phone, open `$APP_URL` and choose **Add to Home Screen** to install the PWA.

## 4. CI/CD: GitHub Actions with OIDC
### 4.1 Create the deploy identity
```bash
export GH_REPO="<github-owner>/<repo>"
APP_ID=$(az ad app create --display-name "stocksync-github-deploy" --query appId -o tsv)
az ad sp create --id "$APP_ID" >/dev/null
az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"github-production\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:${GH_REPO}:environment:production\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"
# Least privilege: push images, and update this resource group's Container App.
az role assignment create --assignee "$APP_ID" --role AcrPush \
  --scope "$(az acr show -n "$ACR_NAME" --query id -o tsv)"
az role assignment create --assignee "$APP_ID" --role Contributor \
  --scope "$(az containerapp show -n stocksync-app -g "$RG" --query id -o tsv)"
```

### 4.2 Configure the GitHub repository
Settings → Environments → create **`production`** (optionally add required reviewers for manual approval). Then add:

| Kind | Name | Value |
|---|---|---|
| Secret | `AZURE_CLIENT_ID` | `$APP_ID` |
| Secret | `AZURE_TENANT_ID` | `az account show --query tenantId -o tsv` |
| Secret | `AZURE_SUBSCRIPTION_ID` | `az account show --query id -o tsv` |
| Variable | `ACR_NAME` | `$ACR_NAME` |
| Variable | `CONTAINER_APP_NAME` | `stocksync-app` |
| Variable | `AZURE_RESOURCE_GROUP` | `$RG` |

Every push to `main` now runs **lint → type-check → tests (against PostgreSQL) → build → Bicep validation**, then builds the image, pushes `stocksync:<sha>`, rolls out a new revision and smoke-tests `/healthz`. Pull requests run the test job only.

## 5. Connecting WhatsApp, Messenger, Instagram & Telegram
All webhooks are served by the app itself:

| Platform | Webhook URL | Auth |
|---|---|---|
| WhatsApp, Messenger, Instagram | `$APP_URL/webhooks/meta` | Verify token (handshake) + `X-Hub-Signature-256` HMAC with the app secret |
| Telegram | `$APP_URL/webhooks/telegram` | `X-Telegram-Bot-Api-Secret-Token` header |

### 5.1 Meta (one app covers all three)
1. In [developers.facebook.com](https://developers.facebook.com), create an app of type **Business** and note the **App secret** (App settings → Basic).
2. Pick a random **verify token**: `openssl rand -hex 16`.
3. **WhatsApp:** add the *WhatsApp* product, then note the **Phone number ID**. Create a **System User** in Business Settings with a **permanent access token** that has `whatsapp_business_messaging`. Under WhatsApp → Configuration → Webhook, enter the callback URL above and your verify token, then subscribe to **messages** (button and list taps arrive as `messages` too).
4. **Messenger:** add *Messenger*, link your Facebook Page, generate a **Page access token**, set the same webhook and subscribe the page to **messages** and **messaging_postbacks** (quick-reply taps arrive as messages; postbacks cover menu and "Get Started" taps).
5. **Instagram:** connect an Instagram **professional** account to the Page, add *Instagram* messaging, use a Page token with `instagram_manage_messages`, and subscribe to **messages** and **messaging_postbacks**.

### 5.2 Telegram
1. Talk to **@BotFather** → `/newbot` → copy the bot token.
2. Pick a webhook secret: `openssl rand -hex 24` (letters, digits, `_` and `-` only).

### 5.3 Store the channel secrets and redeploy
Create `infra/channels.secrets.json`. It is git-ignored, so never commit it. Include only the channels you use:
```json
{
  "META_APP_SECRET": "…",
  "META_VERIFY_TOKEN": "…",
  "WHATSAPP_TOKEN": "…",
  "MESSENGER_PAGE_TOKEN": "…",
  "INSTAGRAM_PAGE_TOKEN": "…",
  "TELEGRAM_BOT_TOKEN": "…",
  "TELEGRAM_WEBHOOK_SECRET": "…",
  "RAZORPAY_KEY_ID": "rzp_test_…",
  "RAZORPAY_KEY_SECRET": "…",
  "RAZORPAY_WEBHOOK_SECRET": "…"
}
```
```bash
az deployment group create -g "$RG" -f infra/main.bicep \
  -p deployApp=true imageTag=stocksync:latest adminEmail="$ADMIN_EMAIL" \
     postgresAdminPassword="$PG_PASSWORD" jwtSecret="$JWT_SECRET" adminPassword="$ADMIN_PASSWORD" \
     whatsappPhoneNumberId="<PHONE_NUMBER_ID>" channelSecrets=@infra/channels.secrets.json

# Telegram: register the webhook (the Meta webhooks are registered in the Meta dashboard)
curl -fsS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=$APP_URL/webhooks/telegram" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","callback_query"]'   # callback_query = taps on inline buttons
```
The secrets go to Key Vault, and the app reads them through its managed identity. **Settings → Messaging channels** turns green for each configured channel.

### 5.4 Test it
Send `help`, `catalog`, `stock <SKU>`, `price <SKU>`, `order <SKU> 2` and `status <n>` to your WhatsApp number or bot. Orders appear live on the dashboard and in **Orders**, and chats appear in **Inbox**. In **Settings → Low-stock alert recipients**, add your own WhatsApp number or Telegram chat id. Get the chat id from the Inbox after you message the bot.

> **WhatsApp 24-hour rule:** WhatsApp only delivers free-form messages (alerts, order updates) to people who messaged your number in the last 24 hours. Customers who just ordered are always inside the window. For staff alerts, either message the bot daily or register approved Meta message templates.

### 5.5 Payments with Razorpay (test first, then live)
Customers can pay online from the shop and from chat (UPI, cards, netbanking) through **Razorpay Payment Links**; cash on delivery stays available. Online payment needs **all** of: the three Razorpay secrets on the server, the shop currency set to **INR**, and the switch turned on in Settings → Payments. Settings → Payments tells you which one is missing.

**Step 1 — test mode (free, no real money)**
1. Create a Razorpay account and switch the dashboard to **Test Mode**.
2. Generate **test API keys** (look for *API Keys* in Settings). You get a Key ID (`rzp_test_…`) and a Key Secret (shown once — store it).
3. Add a **webhook** (look for *Webhooks* in Settings):
   - URL: `$APP_URL/webhooks/razorpay` (Settings → Payments in StockSync shows the exact URL)
   - Secret: any long random string, e.g. `openssl rand -hex 24` — keep it, it is `RAZORPAY_WEBHOOK_SECRET`
   - Events: **`payment_link.paid`**, **`payment_link.expired`**, **`payment_link.cancelled`**, and (for one-click refunds) **`refund.processed`**, **`refund.failed`**
4. Put `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` into `infra/channels.secrets.json` and redeploy as in 5.3 (they go to Key Vault).
5. In StockSync: **Settings** → currency `INR`, set a **default warehouse** (paid orders are confirmed from it automatically), and check the Payments card shows ✅ *Online payments are available*.
6. Test it: place an order on `$APP_URL/shop` choosing **Pay online**, pay with Razorpay's test card or test UPI details (they are listed in Razorpay's Test Mode documentation), and watch the order page change to *Payment received — your order is confirmed*. Then check **Orders** (badge *paid*, status *confirmed*, stock reduced) and repeat from WhatsApp by tapping **Browse → … → Checkout → Pay online**.

**Step 2 — go live**
1. Complete Razorpay's KYC/activation for your business.
2. Switch the dashboard to **Live Mode** and generate **live keys** (`rzp_live_…`). Create a **new** webhook there (same URL and events) with a **new** secret — test and live use separate keys and secrets.
3. Replace the three secrets (`az keyvault secret set` or update the JSON and redeploy as in 5.3).
4. Make one small real payment end to end, then refund it from the Razorpay dashboard and press **Mark refunded** in StockSync (see 5.7).
5. Keep a separate staging copy on test keys for trying changes.

**How money is kept safe (so you know what to expect)**
- The amount always comes from the order on the server; customers cannot change it.
- Only Razorpay's **signed webhook** marks an order paid — never the page the customer lands on after paying.
- A paid order is confirmed automatically and stock is deducted once, even if Razorpay sends the event several times.
- Payment links expire after the validity set in Settings (default 24 h). Shoppers can get a fresh link from their order page; chat customers can tap **Try again** or ask staff to use **Send link** on the order.

### 5.6 Tap-to-order in chat
Customers say "hi" and tap **Browse / My cart / My orders**, choose a category and product, pick a quantity, and check out with **Pay online** or **Cash on delivery** — no typing needed. The old text commands (`catalog`, `stock TEE`, `order TEE 2`, `status 12`) still work.
- **WhatsApp** shows real buttons, scrolling list menus and a **Pay** button. **Telegram** shows inline buttons. **Messenger/Instagram** show quick-reply chips. Anywhere else, options appear as a numbered list and the customer replies with the number.
- WhatsApp only allows free-form and interactive messages within **24 hours of the customer's last message**. Customers who are shopping are always inside that window; for staff alerts or later follow-ups, either register approved message templates with Meta or have staff message the bot daily.
- Telegram needs `callback_query` in `allowed_updates` (see 5.2) and Messenger/Instagram need the `messaging_postbacks` subscription (see 5.1), otherwise taps are not delivered.
- To test without a phone: `npm run e2e` runs a scripted WhatsApp conversation against local fakes (see section 6).

### 5.7 What staff do when a payment alert arrives
| Alert / badge | Meaning | What to do |
|---|---|---|
| ⚠️ *Order #N was paid online but could not be confirmed (insufficient stock…)* — order shows **Refund due** | The customer paid but the goods ran out before confirmation | Refund in the Razorpay dashboard (Payments → the payment → Refund), then press **Mark refunded** on the order. The customer is told automatically |
| ⚠️ *Paid order #N was cancelled — refund the customer* | You cancelled an order that was already paid | Same: refund in Razorpay, then **Mark refunded** |
| ⚠️ *Duplicate payment for order #N: pay_… was paid after the order was already paid* | The customer paid two different links | Refund the **second** payment (the `pay_…` id in the alert) in Razorpay. The order itself is fine |
| ⚠️ *Order #N is PAID but could not be auto-confirmed: no default warehouse is set* | Payment received, but no warehouse was configured | Set a default warehouse in Settings, then **Confirm** the order manually |
| Order shows **unpaid** for a long time | The customer opened the payment page but never paid | Press **Send link** to remind them in chat, or **Cancel** the order (the link is cancelled automatically) |

Refunds are **not** issued automatically: you do them in Razorpay and then record them in StockSync.

### 5.7b WhatsApp templates and delivery receipts (Release 3)

WhatsApp only allows free-form messages to a customer within **24 hours** of their last message. Order updates, payment links, refund notices and staff alerts often come later, so they need a **template** that Meta has approved.

1. In **WhatsApp Manager → Message templates**, create one template per event you care about (category *Utility*). Write the body with numbered placeholders, e.g. `Hi {{1}}, your order #{{2}} is confirmed. Total {{3}}.` and submit it for approval.
2. In StockSync open **Settings → WhatsApp templates**. For each event enter the template **name** and **language** exactly as approved, and the **parameters in placeholder order**, using any of: `orderNumber, total, businessName, customerName, productName, quantity, paymentLink`. Example: `customerName, orderNumber, total`.
3. Save. From then on the app sends free-form text inside the 24-hour window and the template outside it. If an event has no template, the message shows **Failed — outside 24h window — no template configured** in the Inbox, and staff can fix the mapping and press **Retry**.

**Delivery ticks.** The existing Meta webhook already carries delivery receipts: in the Meta dashboard keep the WhatsApp **messages** field subscribed (it delivers both inbound messages and `statuses`). No new URL or secret is needed. The Inbox then shows ⏳ sending, ✓ sent, ✓✓ delivered and read, or **Failed** with Meta's reason and a **Retry** button.

**Cleanup (Settings → Maintenance).** Unpaid online orders are cancelled after the chosen number of hours (default 48), webhook records older than 30 days are deleted daily, and chat history older than the retention days (default 365; 0 keeps everything) is deleted daily.

**Health.** `/healthz` is a cheap liveness check. `/readyz` also checks migrations and the background worker and returns 503 naming the failing check; the Container App readiness and startup probes use it. Admins see queue depth, failed messages and the last cleanup runs on the Dashboard under **System health**.

### 5.7c GST invoicing, barcodes and refunds (Release 4)

**GST invoices.** In **Settings → GST invoicing** enter your legal name, GSTIN, registered address and state (the state must match the first two digits of the GSTIN) and an invoice prefix. Until all of these are filled in, nothing is invoiced and orders still confirm normally. Then set an **HSN/SAC code** and **GST rate** on each product (Products → edit). Shop prices are treated as GST-**inclusive** (MRP); the tax is calculated backwards from the price, so what the customer pays never changes. For a business buyer add their GSTIN and state on the customer record, and the invoice switches to IGST when their state differs from yours.
- An invoice is created when an order is **confirmed**; staff download it from **Orders → Invoice**, and the customer gets it on WhatsApp (as a document, or as the `invoice_ready` template outside the 24-hour window, see §5.7b; add `invoiceLink` as a template parameter) or as a link on other chat channels and on their order page.
- Invoice numbers run `PREFIX/2026-27/000001` and restart every 1 April. A cancelled order's invoice becomes VOID and its number is never reused.
- **Before real use, have your chartered accountant check a sample invoice** (layout, wording, rounding). E-invoicing (IRN/QR on the government portal) is not included. Invoice PDFs embed **Noto Sans** and **Noto Sans Devanagari** (SIL Open Font License 1.1, installed as the `@fontsource` packages) so the rupee sign and Hindi (Devanagari) names print correctly. Other scripts (Tamil, Bengali, emoji…) are not covered and print as `?`. If the font files were ever missing the PDF falls back to a basic font and `Rs.`.

**Barcodes and stock counts.** Add a barcode to a product (13 digits must be a valid EAN-13). USB and Bluetooth scanners work like a keyboard: click the scan box and scan. The phone camera works in browsers that support barcode detection (Chrome on Android, recent Safari); others use the typing box. **Stock counts** (menu → Stock counts): start a count for a warehouse, scan each item (each scan adds one), fix quantities, **Save**, then **Submit** to correct stock; every difference is recorded in Movements as "Stock count #N". With no signal, Save keeps the counts on the phone and they sync when it is back online; load the page while you still have signal.

**Purchasing.** Menu → Purchasing: create a purchase order for a supplier, **Send**, and **Receive** as goods arrive (partial deliveries are fine). The Dashboard's **Reorder suggestions** card creates draft orders for low-stock products from their usual supplier.

**Refunds.** For an order marked *refund due*, **Refund via Razorpay** sends the refund for exactly what Razorpay captured (the browser cannot change the amount). The order shows *Refund in progress* until Razorpay's signed webhook confirms; then it becomes *refunded* and the customer is told. In the Razorpay webhook settings also enable **refund.processed** and **refund.failed**. If Razorpay does not answer, wait a minute and press the button again: the same request is repeated and cannot refund twice. **Mark refunded** remains for refunds you do in the Razorpay dashboard. Not yet verified against the live Razorpay API, see §5.8.

### 5.8 Verify against the real services (test keys, ~15 minutes)

The automated tests use fakes that follow the providers' documentation. This run checks that reality matches. It needs **test** credentials only and costs nothing (the Razorpay link is ₹1 and is cancelled; WhatsApp test-number messages are free).

```bash
export RAZORPAY_KEY_ID=rzp_test_...   RAZORPAY_KEY_SECRET=...        # Razorpay → Test Mode → API Keys
node scripts/verify/real-services.mjs razorpay
```
It refuses to run with a non-`rzp_test_` key. Expect 4 PASS lines. Open the printed link and pay with the test UPI id `success@razorpay`.

```bash
export RAZORPAY_WEBHOOK_SECRET=...                                    # the secret you set on the test webhook
node scripts/verify/real-services.mjs razorpay-webhook 8787           # then expose :8787 with a tunnel (cloudflared / ngrok)
```
Set the test webhook URL to the tunnel, pay a link, and confirm `real webhook signature valid (payment_link.paid)` appears. If it prints FAIL or different payload keys, **stop and tell the engineer**: the app's parser needs a fix (file it with `engine add-task`).

```bash
export WHATSAPP_TOKEN=...  WHATSAPP_PHONE_NUMBER_ID=...  VERIFY_WHATSAPP_TO=91XXXXXXXXXX
node scripts/verify/real-services.mjs whatsapp
```
First send any message to the test number from `VERIFY_WHATSAPP_TO` (this opens the 24-hour window). Expect 4 PASS lines (buttons, list, pay button, template). On the phone, tap a button and check the Inbox shows the tap, and that the message ticks go sent → delivered → read.

Paste the PASS/FAIL output into `docs/7_SECURITY_AUDIT.md` under "Real-service verification". Until that is done, payments and WhatsApp are verified **only against fakes**.

## 6. Local development
```bash
cp .env.example .env               # fill in values; .env is git-ignored
docker compose up --build          # app + PostgreSQL + Azurite (Blob emulator) → http://localhost:3005 (override with APP_PORT=…)
```
Or without Docker: run PostgreSQL locally, then `npm install && npm run dev` (API on :8080, Vite on :5173 with proxy).
Quality gate (same as CI): `npm run typecheck && npm run lint && npm test`. Tests need PostgreSQL at `TEST_DATABASE_URL` (default `postgres://postgres@localhost:5432/inventory_test`).

**End-to-end test (payments and chat).** `npm run build && npm run e2e` starts the production build against a fresh database with local stand-ins for Razorpay and WhatsApp, then drives a real browser through *shop → pay online → order confirmed* and a scripted WhatsApp conversation (28 checks). It needs PostgreSQL (`E2E_DATABASE_URL`, default `postgres://postgres@localhost:5432/inventory_e2e`, recreated each run) and Playwright: `npm i --no-save playwright && npx playwright install chromium`. CI runs it on every push. It proves StockSync's own flows; a run against real Razorpay test keys (section 5.5) is still the final check.

To test webhooks from a laptop, expose port 8080 with a tunnel (e.g. `devtunnel host -p 8080 --allow-anonymous` or ngrok) and use that HTTPS URL in Meta and Telegram.

## 7. Operations
| Task | How |
|---|---|
| Live logs | `az containerapp logs show -n stocksync-app -g $RG --follow` |
| Metrics, traces, failures | Azure Portal → Application Insights `stocksync-ai-*` |
| Roll back | `az containerapp update -n stocksync-app -g $RG --image $ACR_NAME.azurecr.io/stocksync:<previous-sha>` |
| Rotate a secret | `az keyvault secret set --vault-name <kv> -n jwt-secret --value …` then `az containerapp revision restart …` |
| Payment health | Razorpay Dashboard → Webhooks shows delivery failures; StockSync's Orders page shows **Refund due** orders (highlighted red). Check both daily at first |
| Clean old webhook records | `DELETE FROM webhook_events WHERE received_at < now() - interval '30 days';` monthly (Razorpay retries for about a day) |
| Abandoned online orders | Unpaid online orders are not cancelled automatically. Review *unpaid* orders weekly and cancel stale ones (a customer is limited to 15 open orders) |
| Prove the payment flows | `npm run build && npm run e2e` runs the browser end-to-end test against local fakes (also a CI job) |
| Database backups | Automatic, 7-day point-in-time restore (raise in Bicep `backupRetentionDays`) |
| Scale | Single replica by design (in-process realtime bus). Add Azure Web PubSub before raising `maxReplicas` |
| Harden networking | Move PostgreSQL to VNet integration / private endpoint and drop the `AllowAzureServices` firewall rule |

Security posture and accepted risks: see `docs/7_SECURITY_AUDIT.md`.

### Hardening notes
- The CI/CD deploy job only runs for `main` (push or manual run), tags images with the commit SHA only (no `:latest`), and rolls back to the previous image if the health check fails.
- In production over https, the server refuses to start with the default admin password (`ChangeMe123!`) or one shorter than 12 characters. Set a unique `ADMIN_PASSWORD` secret.
- `.github/workflows/security.yml` runs CodeQL and `npm audit` on every PR and weekly.
- The rate limiter and live-event bus are in-process: keep **one replica** until they are moved to Redis or the database.

## Process roles (T103)
The same image runs in three modes selected by `PROCESS_ROLE`: `all` (default: HTTP and background work in one process, for local use and a single replica), `api` (HTTP only; its `/readyz` is ready when the database answers, migrations are applied and **some** worker's heartbeat is under 60 s old) and `worker` (jobs, scheduler, maintenance; serves only `/healthz` and `/readyz` for its probes). `infra/main.bicep` deploys two Container Apps: `<app>` with `PROCESS_ROLE=api` (1–5 replicas, HTTP scale rule) and `<app>-worker` (1–3 replicas, CPU rule, no ingress). Realtime events cross replicas through Postgres LISTEN/NOTIFY, and the worker publishes through the same channel. The Bicep change is uncompiled here (no `az` in the build environment): run `az bicep build` before the first deploy.

## Accessibility (WCAG 2.2 AA) — checks and manual checklist (T113)
**Automated, on every gate:** `src/web/src/a11y.test.tsx` runs axe-core 4.14.1 (WCAG 2.0/2.1/2.2 A and AA plus best-practice rules) on all 24 pages in English and in Hindi and on the app shell (landmarks, skip link first in tab order, `aria-expanded` on the menu button) — zero violations required. `src/web/src/contrast.test.ts` computes WCAG contrast from the colour tokens in `styles.css` for both light and dark schemes: text pairs ≥ 4.5:1, badge tints ≥ 4.5:1, focus ring ≥ 3:1. (axe's own contrast rule needs real layout and cannot run in jsdom, hence the token test.) The audit found and fixed: table columns with empty headers, product headings that skipped a level, no skip link, no landmark names, menu button without state, and success and warning colours that fell below 4.5:1 on their own badge tint.
**By design:** every page works with keyboard alone; focus rings are 3 px and never removed; `prefers-reduced-motion` stops animation and smooth scrolling; forced-colours mode keeps borders and focus; controls are at least 36 px tall (28 px minimum for small ones, above the 24 px of WCAG 2.5.8); results of actions are announced (`role="status"` / `role="alert"`); charts are titled, described images whose every value is also in a captioned table; language is announced (`<html lang>` follows the chosen language, and the language switch labels itself in the chosen language).
**Manual checklist before a release (cannot be automated in this repository; not yet performed by a person with assistive technology):**
1. Tab through sign-in, the dashboard, products, orders, settings and the public shop with the keyboard only: order is logical, nothing is skipped, nothing traps focus, the focus ring is always visible.
2. With NVDA (Windows, Firefox/Chrome), VoiceOver (macOS/iOS) and TalkBack (Android): the page title, landmarks, form labels, table headers, error and status messages and the Hindi pages (screen readers must switch to a Hindi voice) are read correctly.
3. Zoom to 200 % and 400 % (320 px wide): no horizontal scrolling of the page, no overlap, nothing cut off.
4. Windows "High contrast" and the browser's forced-colours emulation: all controls still visible.
5. Reduce motion on in the OS: no animation remains.
6. Spot-check colour contrast of any new colour with a tool, and add its pair to `contrast.test.ts`.

## Performance budgets (T114)
**Front end.** Every screen is its own lazily loaded chunk (a shopper never downloads the administration screens). `npm run build` ends with `scripts/check-bundle.mjs`, so CI and the build gate fail when gzip sizes pass: initial JavaScript (entry + preloads) 100 KB, any one route chunk 15 KB, all JavaScript 170 KB. Reference build: initial 88.4 KB (was 117 KB as one file), largest route chunk 7.1 KB (Settings), total 132 KB. Raise a budget only deliberately, in that script.
**Back end.** `src/api/tests/perf.test.ts` seeds 10,000 products (two warehouses, 5,000 historic orders with 20,000 lines) into a real PostgreSQL and times each operation 40 times through the whole HTTP stack; the 95th percentile must stay under the budget. Reference run (single developer VM, Postgres 16 on the same host; ms):

| Operation | p50 | p95 | Budget |
|---|---|---|---|
| Product list (first page) | 41 | 48 | 250 |
| Search by name | 25 | 42 | 200 |
| Search by SKU | 26 | 40 | 200 |
| Barcode lookup | 11 | 13 | 60 |
| Dashboard figures | 18 | 29 | 150 |
| Low-stock list | 12 | 16 | 100 |
| Stock levels (all) | 69 | 94 | 400 |
| Create an order of 3 lines | 7.5 | 11 | 80 |
| Analytics: sales / best sellers / funnel | 18 / 32 / 6 | 27 / 46 / 7.5 | 150 / 200 / 60 |
| Reorder suggestions with forecasting | 38 | 57 | 400 |

Indexes: the analytics indexes (migration 028) plus the existing key indexes were enough at this size; no further index was needed. Name and SKU search use `ILIKE '%…%'`, which scans the product table (~25 ms at 10,000); beyond roughly 100,000 products add a `pg_trgm` GIN index (the extension must be allow-listed on Azure Database for PostgreSQL via `azure.extensions`). The budgets are 4–6× the reference numbers so a slower CI runner passes but a lost index or an accidental N+1 query does not. Production latency also includes the network and Azure's database tier; these numbers are a regression guard, not a promise. To record a new reference run: `PERF_REPORT=perf.json npx vitest run tests/perf.test.ts` in `src/api`.
