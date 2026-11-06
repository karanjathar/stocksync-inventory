
# /engine-resume — Recover state cheaply (after /clear or in a new session)

1. Run `{{engine}} status`. Do **not** read the whole docs folder.
2. If a task is in progress, read `docs/5_CURRENT_TASK.md` and `git status` / `git diff --stat` to see partial work.
3. Report in ≤ 5 lines: last completed task, current/next task, blockers, pending approvals.
4. If nothing blocks and no approval is pending, continue with the /engine-build loop. Otherwise stop and say what the human must do.
