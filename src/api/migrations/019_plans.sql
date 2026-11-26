-- Release 5 (T98): plans with limits, and per-business monthly usage counters.
-- A NULL limit means unlimited. Prices are integer minor units (paise) per month and are edited by the platform operator, not in code.
CREATE TABLE plans (code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'), name text NOT NULL,
  price_minor integer NOT NULL DEFAULT 0 CHECK (price_minor >= 0), currency text NOT NULL DEFAULT 'INR',
  max_products integer CHECK (max_products >= 0), max_users integer CHECK (max_users >= 1),
  max_chat_messages integer CHECK (max_chat_messages >= 0), max_invoices integer CHECK (max_invoices >= 0),
  sort integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO plans (code, name, price_minor, max_products, max_users, max_chat_messages, max_invoices, sort) VALUES
  ('FREE', 'Free', 0, 50, 2, 200, 20, 1),
  ('PRO', 'Pro', 99900, 2000, 10, 5000, 500, 2),
  ('BUSINESS', 'Business', 299900, NULL, NULL, NULL, NULL, 3);
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_fk FOREIGN KEY (plan) REFERENCES plans(code);
-- The business that existed before multi-tenancy is the operator's own deployment: never limited.
UPDATE tenants SET plan = 'BUSINESS' WHERE slug = 'default';
-- Default privileges give the app role full access to new tables: plans are read-only for it.
REVOKE ALL ON plans FROM stocksync_app;
GRANT SELECT ON plans TO stocksync_app;
GRANT SELECT, INSERT, UPDATE ON plans TO stocksync_platform;

CREATE TABLE usage_counters (tenant_id uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants(id),
  metric text NOT NULL CHECK (metric IN ('chat_messages', 'invoices')), period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0), PRIMARY KEY (tenant_id, metric, period));
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_counters USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, UPDATE ON usage_counters TO stocksync_app;
