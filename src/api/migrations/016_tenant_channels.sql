-- Release 5 (T94): each business keeps its own channel and payment credentials, encrypted (AES-256-GCM, business id as associated data).
CREATE TABLE tenant_channels (tenant_id uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('meta','whatsapp','messenger','instagram','telegram','razorpay')),
  config_encrypted bytea NOT NULL, key_version int NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, kind));
CREATE INDEX idx_tenant_channels_tenant ON tenant_channels (tenant_id);
ALTER TABLE tenant_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_channels USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Webhook URLs carry the business id; only ACTIVE businesses answer.
CREATE FUNCTION tenant_is_active(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM tenants WHERE id = p_id AND status = 'ACTIVE')
$$;
REVOKE ALL ON FUNCTION tenant_is_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_is_active(uuid) TO stocksync_app;
