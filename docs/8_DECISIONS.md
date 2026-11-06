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

## D-010 Release 3 targets Zoho-Inventory-class parity, not full accounting (2026-11-06)
**Context:** The owner asked that StockSync meet mainstream inventory-software standards. **Decision:** Build purchasing, tax/invoicing, returns, bundles, tracking, costing, reports, import/export and audit (PRD 1.9). Do not build a general ledger, multi-currency or marketplace connectors. **Consequences:** Large but bounded scope (25 tasks, five phases). Accounting export (CSV) is the integration point for external accounting tools.

## D-011 Tax in basis points, rounded per line, invoices immutable (2026-11-06)
**Context:** GST needs exact, reproducible totals and legally stable documents. **Decision:** Rates are integer basis points; tax is rounded half-up per line and totals are sums of rounded lines. Invoices are snapshots and are never edited; corrections are credit notes. Invoice numbers are gapless per year. **Consequences:** Totals match the customer-visible document and Razorpay amounts. Changing a rate never alters past invoices.

## D-012 Weighted-average costing (2026-11-06)
**Context:** Valuation and margin need a cost basis. **Decision:** Moving weighted average per product and warehouse; issues use the current average. FIFO layers are not built. **Consequences:** Simple and cheap to maintain. Margin is approximate for products with volatile purchase prices. FIFO can be added later by adding cost layers.

## D-013 Tracking is opt-in per product; bundles hold no stock (2026-11-06)
**Context:** Most products need no batch or serial data, and forcing it would slow every sale. **Decision:** `products.tracking` is NONE, BATCH or SERIAL. Bundles derive availability from components and deduct components on sale. All paths still go through StockService. **Consequences:** Existing data and flows are unchanged; sums by batch must equal stock levels (tested).

## D-014 No new runtime dependencies for documents and barcodes (2026-11-06)
**Context:** Every dependency adds supply-chain risk. **Decision:** Invoices, packing slips and picklists are escaped HTML with print CSS (users print to PDF); barcodes are server-generated SVG. **Consequences:** No PDF library. Pixel-perfect PDFs and emailing documents can come later.

## D-015 One audited dependency for QR encoding (2026-11-06)
**Context:** D-014 forbids new runtime dependencies, but QR encoding needs Reed-Solomon error correction and is easy to get wrong by hand. **Decision:** Add a single small, widely used QR library, pinned to an exact version, checked for maintenance and peer compatibility, with `npm audit` kept clean. QR generation is only exposed for fixed targets. **Consequences:** One extra supply-chain dependency; no hand-rolled encoder. Barcodes (Code 128 and EAN-13) remain in-house.

## D-016 Retail ideas chosen from public evidence only (2026-11-06)
**Context:** The owner asked to learn from DMart and similar retailers. A web search gave public descriptions of DMart Ready (home delivery in time slots or free pick-up point, discount versus MRP, order minimums) but nothing verifiable about its scanning or repeat-order features. **Decision:** Implement the generic patterns the evidence supports (MRP and savings, minimum order and fee, pick-up or delivery with slots, order again) plus QR features that fit StockSync's own flows (product and shop QR, camera scanning, handover QR, UPI QR at the counter). **Consequences:** Features are modelled on common retail practice, not a copy of any app. Loyalty and coupons are deferred.
