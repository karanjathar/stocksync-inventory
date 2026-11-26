-- Release 5 (T96): self-service sign-up. A business is created only AFTER its owner proves control of the email address.
-- Until then the request waits in signup_requests, which the application role cannot read or write directly: every access is through
-- the SECURITY DEFINER functions below (pinned search_path), so a leaked app connection cannot list pending sign-ups or password hashes.
CREATE TABLE signup_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE, slug text NOT NULL UNIQUE, business_name text NOT NULL, owner_name text NOT NULL, password_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  send_count integer NOT NULL DEFAULT 1, last_sent_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON signup_requests FROM PUBLIC, stocksync_app;

-- Returns 'sent' (a verification email should go out), 'email_registered' (an account already exists: send a notice instead),
-- 'throttled' (too soon / too many sends: send nothing) or 'slug_taken'. The caller answers 'sent', 'email_registered' and 'throttled' identically.
CREATE FUNCTION signup_begin(p_email text, p_slug text, p_business text, p_owner text, p_hash text, p_token_hash text, p_expires timestamptz,
                             p_min_interval_sec integer, p_max_sends integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r signup_requests%ROWTYPE;
BEGIN
  DELETE FROM signup_requests WHERE expires_at < now();
  IF EXISTS (SELECT 1 FROM tenants WHERE slug = p_slug) THEN RETURN 'slug_taken'; END IF;
  IF EXISTS (SELECT 1 FROM signup_requests WHERE slug = p_slug AND email <> p_email) THEN RETURN 'slug_taken'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE email = p_email) THEN RETURN 'email_registered'; END IF;
  SELECT * INTO r FROM signup_requests WHERE email = p_email FOR UPDATE;
  IF FOUND THEN
    IF r.send_count >= p_max_sends OR r.last_sent_at > now() - make_interval(secs => p_min_interval_sec) THEN RETURN 'throttled'; END IF;
    UPDATE signup_requests SET slug = p_slug, business_name = p_business, owner_name = p_owner, password_hash = p_hash, token_hash = p_token_hash,
      expires_at = p_expires, send_count = send_count + 1, last_sent_at = now() WHERE id = r.id;
    RETURN 'sent';
  END IF;
  INSERT INTO signup_requests (email, slug, business_name, owner_name, password_hash, token_hash, expires_at)
    VALUES (p_email, p_slug, p_business, p_owner, p_hash, p_token_hash, p_expires);
  RETURN 'sent';
END $$;

-- A fresh link for a pending request. 'sent' or 'throttled'; unknown addresses are 'none' (the caller still answers the same).
CREATE FUNCTION signup_resend(p_email text, p_token_hash text, p_expires timestamptz, p_min_interval_sec integer, p_max_sends integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r signup_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM signup_requests WHERE email = p_email AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  IF r.send_count >= p_max_sends OR r.last_sent_at > now() - make_interval(secs => p_min_interval_sec) THEN RETURN 'throttled'; END IF;
  UPDATE signup_requests SET token_hash = p_token_hash, expires_at = p_expires, send_count = send_count + 1, last_sent_at = now() WHERE id = r.id;
  RETURN 'sent';
END $$;

-- The one-time step that creates the business, its first admin and its default settings, in one transaction. The token is single use.
CREATE FUNCTION signup_complete(p_token_hash text) RETURNS TABLE (tenant_id uuid, slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r signup_requests%ROWTYPE; t uuid;
BEGIN
  SELECT * INTO r FROM signup_requests WHERE token_hash = p_token_hash AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  DELETE FROM signup_requests WHERE id = r.id;
  INSERT INTO tenants (slug, name) VALUES (r.slug, r.business_name) RETURNING id INTO t;
  INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES (t, r.email, r.password_hash, r.owner_name, 'admin');
  INSERT INTO settings (tenant_id, key, value) VALUES (t, 'businessName', to_jsonb(r.business_name));
  RETURN QUERY SELECT t, r.slug;
END $$;
REVOKE ALL ON FUNCTION signup_begin(text, text, text, text, text, text, timestamptz, integer, integer), signup_resend(text, text, timestamptz, integer, integer), signup_complete(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_begin(text, text, text, text, text, text, timestamptz, integer, integer), signup_resend(text, text, timestamptz, integer, integer), signup_complete(text) TO stocksync_app;
