# Current Task: T61 — Outbox: store-then-send with retries
Phase: Phase 10: Durable messaging · Started: 2026-11-26T08:53:38.405Z

## Acceptance criteria
ChannelHub stores every outbound message as queued with its payload before sending, sends immediately, records provider message id and sent; retryable errors (network, 429, 5xx) enqueue message.send with backoff; 4xx ends failed with error code; a message stored but never sent (simulated crash) is sent exactly once by the worker; adapters return provider ids; existing callers and tests unchanged

## Files to touch
src/api/src/channels/hub.ts, src/api/src/channels/whatsapp.ts, src/api/src/channels/telegram.ts, src/api/src/channels/metaPage.ts, src/api/src/channels/types.ts, src/api/src/repositories/messages.ts, src/api/src/jobs/messageSend.ts, src/api/src/container.ts, src/api/src/index.ts, src/api/tests/outbox.test.ts

## Context (auto-extracted — read this instead of whole documents)
_No refs on this task. If you need a contract, open only the matching section of docs/3_SCHEMAS.md._

## Procedure
1. Write a failing test for the acceptance criteria; run it and confirm it fails for the right reason.
2. Implement the minimum code to pass. Surgical edits only.
3. Run `node engine/engine.mjs gate`. On failure fix the root cause — max 3 attempts, then `node engine/engine.mjs block T61 "<reason>"` and stop.
4. Finish with `node engine/engine.mjs done T61 "<what was built + any decision, 2 sentences>"` (re-runs gates, logs, commits).

## Gates
- typecheck: `npm run typecheck`
- lint: `npm run lint`
- test: `npm test`
- build: `npm run build`
- audit: `npm audit --omit=dev --audit-level=high` _(optional)_
