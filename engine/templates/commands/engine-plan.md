
# /engine-plan — Phase 1: Architecture, contracts and task graph

Act as a principal architect (use the **architect** subagent if available). Do **not** write application code.

Read: `engine.config.jsonc`, `docs/1_PRD.md`, `docs/8_DECISIONS.md`. For existing codebases, read only what you need to respect current structure.

Produce:
1. **`docs/2_ARCHITECTURE.md`** — topology diagram (text), directory layout, design patterns, tech stack with **exact versions you verified exist** (check the registry / docs, note peer-dependency constraints), env var keys, how tests run (incl. any database/services tests need), observability, and the deploy target `{{deployTarget}}`.
2. **`docs/3_SCHEMAS.md`** — every data model, DB schema, API request/response contract, event/webhook payload and error format. One `##`/`###` heading per entity/endpoint group so tasks can reference sections (`refs: 3_SCHEMAS.md#Orders`).
3. **`docs/4_TASKS.md`** — phases as `## Phase N: Name`, tasks as one line each:
   `- [ ] T01 <imperative title> | accept: <testable criteria> | files: <paths> | refs: <doc#section,…> | deps: <T#,…>`
   Rules: 15–45 min each · foundation (tooling, config, DB, test harness) first · each task independently testable ·
   include UI/E2E verification tasks for user-facing work · include tasks for every integration (with contract tests against documented payloads) · 3–8 phases.
4. **`.env.example`** — every variable with dummy values and a comment.
5. **`docs/8_DECISIONS.md`** — one entry per significant choice (stack, DB, auth, hosting, notable libraries).
6. If the gates in `engine.config.jsonc` need adjusting for this architecture, update them and run `{{engine}} sync`.

Then **STOP**. Print a summary (phases, task count, key decisions, risks, credentials the human must obtain) and:
"CHECKPOINT — review docs/1–4 and 8. When satisfied, run: `{{engine}} approve plan`, then /engine-build."
Never run `approve` yourself.
