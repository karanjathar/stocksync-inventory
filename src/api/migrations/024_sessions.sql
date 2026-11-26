-- Release 5 (T104): browser sessions. A login starts a "family" of single-use refresh tokens; using one twice means it was stolen, and the whole family dies.
-- Only a hash of each token is stored. A user can end every session at once (sessions_valid_after).
CREATE TABLE refresh_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants(id),
  user_id uuid NOT NULL, family_id uuid NOT NULL, token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refresh_tokens USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
ALTER TABLE users ADD COLUMN sessions_valid_after timestamptz NOT NULL DEFAULT to_timestamp(0);
