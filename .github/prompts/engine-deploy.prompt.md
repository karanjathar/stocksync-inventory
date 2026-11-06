---
mode: agent
description: "Phase 4 — containers, CI/CD and deployment for the configured target"
---

# /engine-deploy — Phase 4: Production deployment

Act as a lead DevOps engineer (use the **devops** subagent if available). Target: **azure-container-apps** · environments: staging → production.

Preconditions: `node engine/engine.mjs status` shows all tasks done and the audit is complete; the deploy checkpoint is approved
(`docs/6_STATE_SUMMARY.md` → Approvals contains `deploy`). If not, STOP and ask the human to run `node engine/engine.mjs approve deploy`.

Produce and **verify locally where possible**:
1. **Container**: multi-stage `Dockerfile` (minimal runtime, non-root user, healthcheck, prod deps only) + `.dockerignore`. Build it.
2. **Local topology**: `docker-compose.yml` with only the services the architecture actually uses (DB, cache, emulators), healthchecks, configurable host ports. Bring it up and hit the health endpoint.
3. **Infrastructure as code** for the target (Bicep/Terraform/CloudFormation/etc.): secrets in the platform's secret store via managed identity, TLS, logs/metrics, backups. Validate/compile it.
4. **CI/CD**: extend `.github/workflows/engine-ci.yml` (or add a deploy workflow): gates → build image → push → deploy **staging** → smoke test → **manual approval** → production → smoke test.
   Use **OIDC/workload identity federation**, not long-lived cloud keys. Include rollback instructions and how DB migrations run.
5. **`docs/DEPLOYMENT_GUIDE.md`**: one-time provisioning commands, CI secrets/variables to set, how to connect each external service/credential, health-check verification, rollback, operations.
6. Commit with `git add -A && git commit -m "ci: deployment pipeline for azure-container-apps"` (the engine's secret guard must stay green).

Report what was verified for real vs. only generated (e.g. cloud deploy not executed without credentials).
