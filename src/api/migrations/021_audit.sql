-- Release 5 (T100): per-business audit trail. Append-only for everyone but the table owner: the application role can read and add rows, never change or remove them.
-- Platform staff can add rows (their own plan and status changes) but cannot read any.
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants(id),
  at timestamptz NOT NULL DEFAULT clock_timestamp(), actor_id uuid, actor text NOT NULL, action text NOT NULL, entity text, entity_id text,
  detail jsonb NOT NULL DEFAULT '{}', ip text);
CREATE INDEX audit_log_tenant_at ON audit_log (tenant_id, at DESC, id DESC);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
REVOKE ALL ON audit_log FROM stocksync_app;
GRANT SELECT, INSERT ON audit_log TO stocksync_app;
GRANT INSERT ON audit_log TO stocksync_platform;

-- The platform console shows each business's monthly usage numbers (counters only, no business records).
GRANT SELECT ON usage_counters TO stocksync_platform;
CREATE POLICY platform_read ON usage_counters FOR SELECT TO stocksync_platform USING (true);
