---
description: "Phase 2 — build tasks with TDD until the autonomy limit or a checkpoint"
model: sonnet
---

# /engine-build — Phase 2: Build loop

Act as a senior engineer (delegate each task to the **implementer** subagent if available). Autonomy: **phase**.

Repeat:
1. `node engine/engine.mjs next`
   - If it reports a **CHECKPOINT**, **ALL TASKS COMPLETE**, or no ready task: stop and report exactly what it said.
2. Read `docs/5_CURRENT_TASK.md` (and only the files it lists). Follow its Procedure:
   failing test first → minimal implementation → `node engine/engine.mjs gate` → fix root causes (max 3 attempts, else `node engine/engine.mjs block`).
3. For user-facing work, also verify behaviour for real (run the app / use the Playwright MCP or an E2E test) — unit tests alone are not proof.
4. `node engine/engine.mjs done <T#> "<what was built + any decision, 2 sentences>"`.
5. Discovered extra work → `node engine/engine.mjs add-task …`; architectural changes → `docs/8_DECISIONS.md`. New env vars → `.env.example`.
6. Continue per autonomy: `task` → stop after one task · `phase` → stop when the engine prints PHASE COMPLETE · `all` → continue until done/blocked/checkpoint.

When stopping, report in ≤ 8 lines: tasks completed, gate status, anything unverified, blockers, and the next command.
