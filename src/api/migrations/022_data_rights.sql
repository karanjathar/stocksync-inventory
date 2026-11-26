-- Release 5 (T101): data rights. Customer erasure marker, a 30-day account-deletion hold, and the one function that can remove a whole business.
ALTER TABLE customers ADD COLUMN erased_at timestamptz;

-- A business asks to be deleted; nothing happens for 30 days and the request can be cancelled until then.
CREATE TABLE deletion_requests (tenant_id uuid PRIMARY KEY DEFAULT current_tenant() REFERENCES tenants(id),
  requested_at timestamptz NOT NULL DEFAULT now(), requested_by text NOT NULL, erase_after timestamptz NOT NULL, cancelled_at timestamptz);
ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deletion_requests USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY platform_all ON deletion_requests TO stocksync_platform USING (true) WITH CHECK (true);
REVOKE ALL ON deletion_requests FROM stocksync_app;
GRANT SELECT, INSERT, UPDATE ON deletion_requests TO stocksync_app;
GRANT SELECT, UPDATE ON deletion_requests TO stocksync_platform;

-- What was erased and when, without any personal data (the business row itself is gone). Platform only.
CREATE TABLE tenant_deletions (erased_tenant_id uuid PRIMARY KEY, slug text NOT NULL, requested_at timestamptz NOT NULL, erased_at timestamptz NOT NULL DEFAULT now(), rows_removed integer NOT NULL);
REVOKE ALL ON tenant_deletions FROM stocksync_app;
GRANT SELECT ON tenant_deletions TO stocksync_platform;

-- Removes every row of one business, including its encrypted channel credentials, in one transaction. It refuses unless a deletion request
-- exists, was not cancelled and its 30-day hold has passed, and it never touches the original single-business tenant.
-- Tables are discovered, not listed (so a future table is covered too), and deleted in as many passes as the foreign keys need.
CREATE FUNCTION tenant_erase(p_tenant uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tabs text[]; tn text; n integer; total integer := 0; passes integer := 0; progress boolean; req deletion_requests%ROWTYPE; slug_v text;
BEGIN
  IF p_tenant = '00000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'the default business cannot be erased'; END IF;
  SELECT * INTO req FROM deletion_requests WHERE tenant_id = p_tenant AND cancelled_at IS NULL AND erase_after <= now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no due deletion request for this business'; END IF;
  SELECT slug INTO slug_v FROM tenants WHERE id = p_tenant;
  UPDATE tenants SET status = 'DELETING' WHERE id = p_tenant;
  SELECT array_agg(DISTINCT c.table_name::text) INTO tabs FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.table_name <> 'deletion_requests';
  LOOP
    passes := passes + 1; progress := false;
    FOREACH tn IN ARRAY tabs LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', tn) USING p_tenant;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN progress := true; total := total + n; END IF;
      EXCEPTION WHEN foreign_key_violation THEN NULL; -- a child table still holds rows: retried in the next pass
      END;
    END LOOP;
    EXIT WHEN NOT progress OR passes > 25;
  END LOOP;
  DELETE FROM deletion_requests WHERE tenant_id = p_tenant;
  DELETE FROM tenants WHERE id = p_tenant;  -- fails (and rolls everything back) if anything is left behind
  INSERT INTO tenant_deletions (erased_tenant_id, slug, requested_at, rows_removed) VALUES (p_tenant, slug_v, req.requested_at, total);
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION tenant_erase(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_erase(uuid) TO stocksync_platform;
