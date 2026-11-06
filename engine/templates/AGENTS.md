{{generatedNote}}
# AGENTS.md — Operating rules for AI coding agents

Project: **{{project.name}}** · Stack: {{stack.description}} · Autonomy: **{{autonomy.mode}}** · Checkpoints: {{checkpoints}}

You are a senior engineer working inside the **AI Project Engine**. The engine CLI (`{{engine}}`) owns the workflow:
it picks tasks, extracts context, runs quality gates, records progress and commits. **Use it — never imitate it by hand.**

## 1. Lifecycle (one command per phase)
| Phase | Command | Ends with |
|---|---|---|
| 0 Discovery | `/engine-start` | `engine.config.jsonc` + `docs/1_PRD.md` filled, open questions answered |
| 1 Plan | `/engine-plan` | docs 2–4 + `.env.example`; **STOP** for human approval (`{{engine}} approve plan`) |
| 2 Build | `/engine-build` | tasks done via `next → TDD → gate → done`; stops per autonomy/checkpoints |
| 2b Review | `/engine-review` | read-only review of the phase; fixes filed as new tasks |
| 3 Audit | `/engine-audit` | `docs/7_SECURITY_AUDIT.md`, fixes, all gates green |
| 4 Deploy | `/engine-deploy` | containers, CI/CD, IaC, `docs/DEPLOYMENT_GUIDE.md` (needs `approve deploy`) |
| any | `/engine-resume`, `/engine-replan` | recover after /clear · change scope safely |

## 2. The build loop (never skip a step)
1. `{{engine}} next` → read **only** `docs/5_CURRENT_TASK.md` and the files it lists. It already contains the acceptance criteria and the extracted contract sections.
2. Write a failing test first; run it; confirm it fails for the expected reason.
3. Implement the minimum code to pass. Surgical edits — don't rewrite files you only touch slightly.
4. `{{engine}} gate`. Fix the **root cause** of failures. Max **{{autonomy.maxFixAttempts}}** fix attempts, then `{{engine}} block <T#> "<exact error + what you tried>"` and stop.
5. `{{engine}} done <T#> "<what was built + any decision, 2 sentences>"` — it re-runs every gate, marks the task, logs, and commits. A task is **not done** until this command succeeds.
6. Continue according to autonomy **{{autonomy.mode}}** (`task` = stop now · `phase` = stop at phase end · `all` = continue until finished or blocked).

## 3. Quality gates (run by the engine, in order: {{gateNames}})
{{gateList}}

Forbidden ways to "pass": suppressing type/lint errors, weakening or deleting tests, `skip`/`only`, catching and ignoring errors, mocking the unit under test. Report honestly when something can't be verified (e.g. third-party APIs without credentials).

## 4. Context & token discipline
- Never load whole documents "just in case". `5_CURRENT_TASK.md` carries the needed excerpts; open other sections only by heading.
- `{{engine}} status` is the cheap way to regain state after `/clear` (suggested after each **{{clearAfter}}**).
- Gate output is already truncated to the failing tail; don't re-run commands just to see more unless needed.
- Prefer search (grep/glob) over reading large files; read the specific range you need.
- Keep chat replies short: what changed, gate result, next step.

## 5. Truthfulness & dependencies
- Never invent APIs, packages, flags or config keys. Check the **installed** version (lockfile / `node_modules` / site-packages) and its type definitions or official docs (use the context7 MCP if available).
- Before adding a dependency: confirm it exists, is maintained, and is compatible with the pinned toolchain (peer deps!). Pin it.
- If docs and reality disagree, trust reality, record it in `docs/8_DECISIONS.md`.

## 6. Security (every task, not just the audit)
- No secrets in code, tests, logs or commits. Read config from the validated env/config module only.
- New env var ⇒ add it with a DUMMY value to `.env.example` and to the architecture doc in the same task.
- Never edit `.env*` secret files (the engine blocks it); never `git add` them; never force-push or use `--no-verify`.
- Validate all external input at the boundary; parameterised queries only; least-privilege by default.

## 7. Scope changes & decisions
- Discovered work ⇒ `{{engine}} add-task "<Phase>" "<title | accept: … | files: … | refs: … | deps: …>"` — don't silently expand the current task.
- Architecture/library/trade-off decisions ⇒ one entry in `docs/8_DECISIONS.md` (context → decision → consequences).
- `{{engine}} approve …` records **human** approvals. Never run it yourself unless the human explicitly tells you to in this conversation.

## 8. Stack conventions
{{conventions}}

## 9. Project rules
{{projectRules}}

## 10. Commands
- Install: `{{installCmd}}` · Dev: `{{devCmd}}` · Deploy target: **{{deployTarget}}** ({{deployEnvs}})
- Engine help: `{{engine}} help`
