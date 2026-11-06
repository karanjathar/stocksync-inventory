---
mode: agent
description: "Phase 3 — security & quality audit before deployment"
---

# /engine-audit — Phase 3: Security & quality audit

Act as a lead security auditor (use the **security-auditor** subagent if available).

1. Automated checks: run `node engine/engine.mjs gate`; run the stack's dependency audit and a secret scan (e.g. `gitleaks detect` if installed);
   grep for hard-coded secrets, disabled type checks / lint suppressions, `TODO|FIXME|HACK`, dangerous sinks (eval, raw SQL string building, innerHTML, shell exec with input).
2. Review controls: authentication & session handling, authorisation on every mutating route, input validation, output encoding,
   injection, SSRF, file upload, CORS/CSP/security headers, rate limiting, webhook signature verification, error handling (no internals leaked),
   logging (no secrets/PII), secrets management, dependency risk, data protection & retention.
3. Fix real issues **test-first** (add tasks with `node engine/engine.mjs add-task "Phase: Hardening" …` and complete them via the normal loop).
4. Write `docs/7_SECURITY_AUDIT.md`: checks run with results, controls verified with evidence (file/test), findings table (ID, severity, fix), accepted risks.
5. Final `node engine/engine.mjs gate` must pass. Report the verdict and tell the human to review before `/engine-deploy`.
