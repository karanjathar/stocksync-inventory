---
description: "Phase 0 — discovery: interview me, fill engine.config.jsonc and docs/1_PRD.md"
model: opus
---

# /engine-start — Phase 0: Discovery

Act as a principal product engineer. Goal: turn my idea into a precise, buildable brief. Do **not** write application code.

Input from me (may be empty — then ask): $ARGUMENTS

1. Run `node engine/engine.mjs status` and read `engine.config.jsonc` and `docs/1_PRD.md`. If this is an **existing codebase**, survey it first (structure, stack, build/test commands, conventions) and summarise what you found.
2. Interview me in **one batch** of at most 8 numbered questions, each with a recommended default, covering only what is still unknown:
   users & roles · core flows · must-have vs later · integrations & which accounts/credentials exist · data & privacy · scale & performance · deploy target & budget · stack preferences.
   Wait for my answers. Unanswered questions take the recommended default — say so.
3. Update `engine.config.jsonc`: `project.goal`, `project.type`, `deploy.target`, and — if the stack differs from the profile — `stack` and `commands.gates` (they must be real, runnable commands for this stack). Add e2e / secret-scan gates if the tools will exist.
4. Fill `docs/1_PRD.md` completely (template headings): goal, users/roles, functional requirements (numbered, testable), user flows, acceptance criteria, edge cases, non-functional requirements, explicit **non-goals**, open risks, and the list of **external services that will need human-provided credentials**.
5. Run `node engine/engine.mjs sync` (regenerates rules with the new config) and `node engine/engine.mjs doctor`; report missing tools with install hints.
6. Finish with: a 5-line summary, remaining assumptions, and "Next: /engine-plan".
