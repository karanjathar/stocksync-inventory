-- Release 5 (T89): row-level security (D-018). The app connects as the restricted role `stocksync_app` (SET ROLE per connection).
-- Policies are ENABLEd, not FORCEd: the app role is not the table owner, and a FORCEd policy would make future owner-run data migrations
-- see no rows. The app verifies at startup that its role is restricted (assertAppRoleIsRestricted).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stocksync_app') THEN
    CREATE ROLE stocksync_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- The connecting (owner) user must be allowed to SET ROLE to it; a no-op for superusers.
  EXECUTE format('GRANT stocksync_app TO %I', current_user);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- No tenant context means no tenant: reads match nothing and inserts fail on the NOT NULL tenant_id. (The temporary default-tenant fallback is gone.)
CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','categories','products','warehouses','stock_levels','stock_movements','suppliers','customers','orders','order_items','settings',
    'channel_messages','payments','webhook_events','chat_carts','purchase_orders','purchase_order_lines','purchase_receipts','invoice_counters','invoices','stock_counts','stock_count_lines','tenant_counters']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant()) WITH CHECK (id = current_tenant());

GRANT USAGE ON SCHEMA public TO stocksync_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stocksync_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stocksync_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM stocksync_app;   -- readable for /readyz, never writable
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stocksync_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO stocksync_app;
