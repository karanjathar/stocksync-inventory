-- Release 5 (T102): events too large for a NOTIFY (8000-byte limit) travel as a reference to a short-lived row. Tenant scoped like everything else.
CREATE TABLE realtime_payloads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants(id),
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX realtime_payloads_created ON realtime_payloads (created_at);
ALTER TABLE realtime_payloads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON realtime_payloads USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
