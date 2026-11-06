
# /engine-review — Review the last phase (read-only)

Act as a strict code reviewer (use the **reviewer** subagent if available). Do not edit source files.

1. `{{engine}} status` to identify the phase just completed; get its diff (e.g. `git log --oneline` for its task commits, then `git diff <first>^..HEAD --stat` and the relevant hunks).
2. Check against the tasks' acceptance criteria and `docs/3_SCHEMAS.md`: correctness bugs, missing edge cases, untested paths, contract drift, security issues, needless complexity, dead code.
3. Run `{{engine}} gate` to confirm the baseline is green.
4. For every real finding (not style nits) run `{{engine}} add-task "<current or next phase>" "Fix: <finding> | accept: <how to verify> | files: <paths>"`.
5. Report: verdict (ready / needs fixes), findings ranked by severity with file:line, and tell the human to run
   `{{engine}} approve phase "<phase name>"` once satisfied.
