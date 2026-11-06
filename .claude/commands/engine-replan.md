---
description: "Change scope: add/split/reorder tasks and record the decision"
model: opus
---

# /engine-replan — Change scope safely

Change requested: $ARGUMENTS

Act as the architect (use the **architect** subagent if available).
1. `node engine/engine.mjs status`; read the affected sections of docs 1–4 only.
2. Assess impact: which requirements, contracts and tasks change; what is already built that must change; risks.
3. Apply: update `docs/1_PRD.md` / `docs/3_SCHEMAS.md` sections, add tasks with `node engine/engine.mjs add-task "<Phase>" "<title | accept: … | files: … | refs: … | deps: …>"`,
   and edit/remove not-started tasks in `docs/4_TASKS.md` (never rewrite history of done tasks — add follow-up tasks instead).
4. Record the change in `docs/8_DECISIONS.md`.
5. If the change is large (new phase, new integration, data-model change), STOP for human approval before building.
