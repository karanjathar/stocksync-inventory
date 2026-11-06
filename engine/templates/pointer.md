{{generatedNote}}
# {{project.name}} — AI rules

All operating rules live in **`AGENTS.md`** at the repository root. Read it before doing anything, and follow it exactly.

Short version:
- Workflow is driven by the engine CLI: `{{engine}} next` → TDD → `{{engine}} gate` → `{{engine}} done <T#> "<summary>"`.
- Read only `docs/5_CURRENT_TASK.md` and the files it lists for the active task.
- Gates: {{gateNames}}. A task is not done until `{{engine}} done` succeeds.
- Never edit or commit `.env*` secret files. Never run `{{engine}} approve` unless the human explicitly asks.
