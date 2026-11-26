-- Release 5 (T91): platform staff, and a login lookup that can find a user's business from the email alone.
CREATE TABLE platform_admins (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, password_hash text NOT NULL,
  name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stocksync_platform') THEN
    CREATE ROLE stocksync_platform NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  EXECUTE format('GRANT stocksync_platform TO %I', current_user);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The platform role manages businesses and platform staff and can read NO business data (it has no grants on any other table).
GRANT USAGE ON SCHEMA public TO stocksync_platform;
GRANT SELECT, INSERT, UPDATE ON tenants TO stocksync_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_admins TO stocksync_platform;
CREATE POLICY platform_all ON tenants TO stocksync_platform USING (true) WITH CHECK (true);

-- A business can read only its own tenant row and can never change its status or plan, even with raw SQL. Platform staff are invisible to it.
REVOKE INSERT, UPDATE, DELETE ON tenants FROM stocksync_app;
REVOKE ALL ON platform_admins FROM stocksync_app;

-- The one deliberate cross-tenant read: find a user by email and report their business, before any tenant context exists.
-- SECURITY DEFINER runs as the table owner (not subject to RLS); search_path is pinned so it cannot be hijacked.
CREATE FUNCTION login_lookup(p_email text)
RETURNS TABLE (id uuid, tenant_id uuid, email text, name text, role text, password_hash text, created_at timestamptz, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.password_hash, u.created_at, t.status
  FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = p_email
$$;
REVOKE ALL ON FUNCTION login_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION login_lookup(text) TO stocksync_app;
