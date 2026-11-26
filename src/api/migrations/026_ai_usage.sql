-- Release 5 (T106): AI usage per business per month, a monthly budget per plan, and an operator kill switch per business.
-- Usage is counted in "units" (input tokens + 5 x output tokens, so the unit tracks cost whatever the model), and a call is reserved BEFORE it is made.
ALTER TABLE plans ADD COLUMN ai_monthly_units bigint NOT NULL DEFAULT 0 CHECK (ai_monthly_units >= 0);
UPDATE plans SET ai_monthly_units = CASE code WHEN 'FREE' THEN 50000 WHEN 'PRO' THEN 2000000 WHEN 'BUSINESS' THEN 20000000 ELSE 0 END;
ALTER TABLE tenants ADD COLUMN ai_enabled boolean NOT NULL DEFAULT true;  -- the operator can switch AI off for one business; the platform role already updates tenants

CREATE TABLE ai_usage (tenant_id uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants(id), period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  units bigint NOT NULL DEFAULT 0 CHECK (units >= 0), input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0, calls integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period));
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_usage USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
REVOKE ALL ON ai_usage FROM stocksync_app;
GRANT SELECT, INSERT, UPDATE ON ai_usage TO stocksync_app;
