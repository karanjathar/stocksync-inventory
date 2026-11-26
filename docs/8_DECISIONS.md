# 8. Decision Log — StockSync
_One entry per significant decision. Newest at the bottom._

<!--
## D-001 <title> (YYYY-MM-DD)
**Context:** … **Decision:** … **Consequences:** …
-->

## D-001 Adopt AI Project Engine v2 for Release 2 (2026-11-06)
**Context:** Release 1 was built with the v1 prompt harness; its rules were advisory. **Decision:** Install `engine/` (v2), keep the existing docs and phases (baselined on plan approval), use the project's own gates and CI (`ci.generateWorkflow: false`), and replace the v1 `mcp-config.json` (not read by any tool) with generated `.mcp.json` / `.vscode/mcp.json`. **Consequences:** Gates, checkpoints and the secret guard are enforced. Rules are generated from `engine.config.jsonc`.

## D-002 Razorpay Payment Links instead of Checkout.js (2026-11-06)
**Context:** We need payments in chat (no browser JS) and on the website, for Indian customers (UPI first). **Decision:** Use the Razorpay **Payment Links** API for both. The chat sends the hosted link, and the web shop redirects to it. **Consequences:** One integration path, no card data or PCI scope in our app, works in WhatsApp. We give up a fully embedded on-page checkout. Checkout.js can be added later for the web only.

## D-003 Webhook is the only source of truth for payment state (2026-11-06)
**Context:** Redirect callbacks can be forged, lost or arrive late. **Decision:** State changes only on a signature-verified webhook, de-duplicated by `X-Razorpay-Event-Id` (`webhook_events` table). The callback signature is verified only to show a friendly status page. **Consequences:** Correct under retries and replays. The status page polls until the webhook lands.

## D-004 Auto-confirm on payment; REFUND_DUE when stock is gone (2026-11-06)
**Context:** Stock is deducted only on confirm (v1 design), so a paid order can become unfulfillable. **Decision:** On a paid webhook, auto-confirm from the default warehouse. If that fails, keep the order PENDING with `paymentStatus=REFUND_DUE` and alert staff. **Consequences:** No silent loss of paid orders. Refunds are manual in the Razorpay dashboard (automation is a non-goal for R2).

## D-005 Channel-neutral BotReply with graceful degradation (2026-11-06)
**Context:** WhatsApp (buttons, lists, URL buttons), Telegram (inline keyboards) and Messenger/Instagram (quick replies) have different limits. **Decision:** The bot returns one `BotReply`. Each adapter renders it within its platform's limits. Unsupported cases fall back to numbered text, and numbered answers map back to actions. **Consequences:** Flows are written once. Limits are enforced centrally by `normaliseReply`.

## D-006 Persisted chat cart and short action ids (2026-11-06)
**Context:** Tap flows span many messages, and Telegram `callback_data` is ≤ 64 bytes. **Decision:** A `chat_carts` table keyed by customer, and compact action ids (`qty:<uuid>:<n>`, ≤ 43 bytes). **Consequences:** Carts survive restarts and multiple replicas. Old taps are validated against current stock.

## D-007 Public order token for the status page (2026-11-06)
**Context:** Order numbers are sequential and guessable. **Decision:** `orders.public_token` (random UUID) identifies orders in public URLs (`/shop/order/<token>`, Razorpay `callback_url`). **Consequences:** Customers can't enumerate other customers' orders.

## D-008 Fake Razorpay for E2E until test keys exist (2026-11-06)
**Context:** Real sandbox calls need the owner's Razorpay test keys. **Decision:** `RAZORPAY_API_BASE` points the client at a local fake implementing the documented endpoints and signing webhooks. Contract tests pin the documented payloads. **Consequences:** Full flows are verifiable offline. A real test-mode run stays a release checklist item until keys are provided.

## D-009 Persist the options shown with each outbound reply (2026-11-06)
**Context:** Channels without rich UI show numbered options, and the user answers "2". Mapping that back needs the options last shown to that user, and must work across restarts and replicas. **Decision:** Migration `002_reply_options.sql` adds `channel_messages.options jsonb`. The hub stores the options it rendered, and the inbox resolves a bare number against the latest outbound message to that user. The payments/chat migration becomes `003_payments_chat.sql`. **Consequences:** No in-memory session state. The criterion moved from T27 to T28.

## D-010 Postgres job queue and message outbox instead of a broker or pg-boss (2026-11-26)
Context: messages are sent inline and lost on failure; we need retries, scheduled maintenance and multi-replica safety.
Decision: a small in-repo queue on a `jobs` table using `FOR UPDATE SKIP LOCKED`, and `channel_messages` doubles as the outbox (store first, send immediately, retry in the background). No new dependency; the plain-SQL migration style is kept.
Consequences: one infrastructure piece (Postgres) to operate; throughput is ample for SMB volume (hundreds of messages/min). Move to Azure Service Bus only if volume demands it.

## D-011 Templates are mapped, not authored (2026-11-26)
Context: WhatsApp only delivers business-initiated messages outside 24 h via Meta-approved templates.
Decision: admins create templates in WhatsApp Manager and map each notification event to a template name, language and ordered parameters in Settings; the app picks free-form vs template by the 24 h window and falls back once on error 131047.
Consequences: no template-approval workflow to build; a wrong mapping fails visibly with Meta's error code.

## D-012 Release 3 = Tier 1 of the top-1% roadmap (2026-11-26)
Context: the owner's goal is a world top-1% product; the audit's accepted risks (silent message loss, 24 h rule, unbounded tables, no readiness) block a confident launch.
Decision: reliability and operations come before new features (GST invoicing, POs, barcode, multi-tenant follow in Tier 2/3).
Consequences: Phases 10–12 below; the real-service run (T67) waits for human-provided test credentials.

## D-013 Prices are GST-inclusive by default; tax is back-calculated per line (2026-11-26)
Context: Indian retail shows MRP (tax included). Existing orders store only totals.
Decision: a setting `gst.pricesIncludeTax` (default true) selects inclusive or exclusive computation; invoices snapshot every input so later setting changes never alter an issued invoice.
Consequences: no change to order totals or payment amounts; an accountant must review before real use; e-invoicing (IRN) is out of scope.

## D-014 Gapless invoice numbers through a locked counter row (2026-11-26)
Decision: one counter row per financial year, locked inside the issuing transaction; a cancelled order voids its invoice and the number is never reused.
Consequences: invoice issuing serialises per year (fine at SMB volume); numbers stay gapless as Indian rules expect.

## D-015 Refund state lives on the payment, not a new order status (2026-11-26)
Decision: the order stays REFUND_DUE until Razorpay's signed `refund.processed` webhook arrives; `payments.refund_status` tracks PENDING/PROCESSED/FAILED. Avoids another enum migration across the web app and chat views.

## D-016 Barcode scanning is progressive (2026-11-26)
Decision: use the browser `BarcodeDetector` API when present and otherwise a text input that also accepts USB/Bluetooth scanners (keyboard wedge); no heavy WASM scanner dependency in v1.

## D-017 Tax-exclusive pricing is computed but not issued yet (2026-11-26)
Context: with exclusive prices the invoice total (taxable + tax) would exceed the order total the customer was actually charged, because checkout, payment links and chat carts all charge the stored price.
Decision: `computeInvoice` supports both modes (tested), but the invoice service (T75) refuses to issue when `gst.pricesIncludeTax` is false and says why; the Settings UI (T78) does not offer the switch. Supporting exclusive pricing means adding tax on top at checkout everywhere, which is a separate, larger change.
Consequences: invoices can never disagree with the amount paid; shops that quote prices before tax must wait for that follow-up.

## D-018 Shared database with row-level security (2026-11-26)
Context: Release 5 hosts many businesses. Decision (owner): one database, `tenant_id` on every table, FORCEd RLS, app connects as a non-owner role. Consequences: isolation holds even if a query forgets its WHERE; tests must run as the app role (a superuser bypasses RLS); one migration path for all tenants.

## D-019 Tenant context through AsyncLocalStorage and a pool wrapper (2026-11-26)
Decision: the authenticated request (or webhook/job) runs inside `tenantContext.run(id)`; the pool wrapper sets `app.tenant_id` on every checked-out connection and clears it on release. Consequence: no signature change across ~40 services; the risk is a forgotten context, which RLS turns into "no rows" instead of a leak.

## D-020 Billing with Razorpay Subscriptions on the platform account (2026-11-26)
Decision (owner): Free/Pro/Business monthly plans, 14-day trial, state changes only from signed subscription webhooks, prices editable by the operator. Failed payment: grace period then downgrade to Free; data is never deleted for exceeding limits.

## D-021 AI is a tool-using agent with hard budgets (2026-11-26)
Decision: Claude via tool use with strict schemas; customer text is untrusted data; tools can only touch the caller's own cart/tenant; orders need an explicit confirmation tap; per-tenant monthly spend cap and kill switch; forecasting is statistical, not LLM.

## D-022 Realtime across replicas with Postgres LISTEN/NOTIFY (2026-11-26)
Decision: no new service; events are published with `pg_notify` (tenant id in the payload) and each replica fans out to its own SSE clients. Revisit Azure Web PubSub only beyond a few thousand concurrent dashboards.

## D-018a Row-level security is ENABLEd, not FORCEd (2026-11-26)
Context: the plan said FORCEd policies. A FORCEd policy also binds the table owner, so any future owner-run data migration would silently see no rows, and the Azure admin cannot bypass it.
Decision: policies are enabled, the app connects through `SET ROLE stocksync_app` (non-owner, NOSUPERUSER, NOBYPASSRLS), a connection that cannot assume the role is discarded (fail closed), and startup refuses to run unless `assertAppRoleIsRestricted` passes. A guard test fails if any table with a `tenant_id` lacks RLS, or a new table is added without choosing between tenant-scoped and platform-level.
Consequences: isolation holds for raw SQL with no WHERE; it does not defend against injected SQL that calls `set_config('app.tenant_id', …)`, so queries stay parameterised (reviewed in T95). Foreign-key checks ignore RLS, so services must still look up referenced rows through tenant-scoped queries (also T95).

## D-023 Per-business webhook URLs instead of routing by payload (2026-11-26)
Context: the plan routed Meta webhooks by `phone_number_id`/page id found inside the payload. That value is attacker-controlled until the signature is verified, and verifying needs the business's secret, so it would require a lookup before authentication, and the GET handshake has no payload at all.
Decision: every business gets its own URL (`/webhooks/meta|telegram|razorpay/<businessId>`, shown in Settings → Channel credentials) and is verified with its own secret; unknown, malformed and suspended ids are 404. The original URLs without an id serve the default business so existing single-business installs keep working.
Consequences: a payload signed for one business can never be accepted for another; each business pastes its own URL into its Meta, Telegram and Razorpay consoles. The business id is not a secret.

## D-024 Server environment keys belong to the default business only (2026-11-26)
Decision: `WHATSAPP_*`, `META_*`, `TELEGRAM_*`, `RAZORPAY_*` keep working for the original default business; any other business that has not saved its own credentials is simply "not configured". Consequence: no business can ever send or take payments through the operator's accounts by accident. Saved credentials are validated strictly; environment values keep their old independent semantics.


## D-025 — Separate API and worker processes (T103)
Context: API replicas could not scale out while jobs, scheduler and maintenance lived in every process, and readiness required the local job loop. Decision: `PROCESS_ROLE=api|worker|all` on one image. The API's readiness requires any fresh worker heartbeat; a worker serves only health probes and checks its own heartbeat. Events published by workers reach dashboards through PgBus (D-022). Consequences: two Container Apps and a second deploy step; if every worker is down the API reports unavailable (traffic stops) rather than silently accepting work that never runs. Migrations remain idempotent and advisory-locked, so any role may run them.

## D-026 — Cookie sessions with rotating refresh tokens (T104)
Context: the web app kept a 12 h bearer JWT in localStorage, readable by any injected script, with no way to end a session. Decision: httpOnly SameSite=Strict cookies, a 15-minute access token, single-use refresh tokens in families with reuse detection, CSRF tokens bound to the session, and revocation by session and by user. Bearer tokens stay for API clients (issued by the same login, revoked by logout-everywhere). Consequences: the web client must echo the CSRF cookie and refresh transparently; GET must never change data (invoice issuing became POST); a stolen refresh token is usable until its owner next refreshes or it is replayed, then the whole family dies.

## D-027 — An intermittent test failure traced to the test, not the product (T115)
Context: `engine done` twice re-ran the gates and failed once while the preceding `gate` had passed. Repeated clean full runs (one at a time: every suite shares one test database, so two runs at once corrupt each other) reproduced it: `aiBudget › concurrent calls cannot overshoot the allowance` assumed 12 calls overlap, but a fast fake API let early calls settle and release their reservation before later ones reserved, so all 12 fitted. Decision: the fake now answers after 200 ms so the reservations genuinely overlap; earlier waits for background writes were also widened. Consequences: the product behaviour (atomic reservation) was correct throughout; tests that depend on timing must make the overlap deliberate. Never run two test processes against the same database.
