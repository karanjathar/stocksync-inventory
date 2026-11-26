-- Release 5 (T95): foreign keys carry the tenant. PostgreSQL ignores row-level security when it checks a foreign key, so a plain FK lets a row in one
-- business point at a row of another (a product in business B with business A's category id). Every single-column FK between two tenant-scoped
-- tables becomes (tenant_id, col) -> parent(tenant_id, id), which makes a cross-business reference impossible at the database level.
DO $$
DECLARE t text; r record; action text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id)', t, t || '_tenant_id_id_key');
  END LOOP;

  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS child, con.confrelid::regclass AS parent, con.confdeltype,
           (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) AS child_col
    FROM pg_constraint con
    WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
      AND (SELECT attname FROM pg_attribute WHERE attrelid = con.confrelid AND attnum = con.confkey[1]) = 'id'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    action := CASE r.confdeltype
      WHEN 'a' THEN '' WHEN 'r' THEN ' ON DELETE RESTRICT' WHEN 'c' THEN ' ON DELETE CASCADE'
      WHEN 'n' THEN format(' ON DELETE SET NULL (%I)', r.child_col)   -- null only the reference, never the tenant
      ELSE NULL END;
    IF action IS NULL THEN RAISE EXCEPTION 'unsupported delete action on %', r.conname; END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.child, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) REFERENCES %s (tenant_id, id)%s', r.child, r.conname, r.child_col, r.parent, action);
  END LOOP;
END $$;
