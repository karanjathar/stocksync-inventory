-- Release 5 (T88): tenants. One database, many businesses (D-018). Existing data becomes the "default" tenant.
-- Row-level security comes in the next migration; this one only adds the column, the per-tenant uniqueness and the per-tenant numbering.
CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text NOT NULL, status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETING')),
  plan text NOT NULL DEFAULT 'FREE', created_at timestamptz NOT NULL DEFAULT now());

INSERT INTO tenants (slug, name)
VALUES ('default', COALESCE((SELECT value #>> '{}' FROM settings WHERE key = 'businessName'), 'My business'));

-- The tenant of the current request (app.tenant_id), falling back to the default tenant until row-level security makes the context mandatory.
CREATE FUNCTION current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, (SELECT id FROM tenants WHERE slug = 'default'))
$$;

-- tenant_id on every business table: backfilled, mandatory, defaulted from the request context, indexed.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','categories','products','warehouses','stock_levels','stock_movements','suppliers','customers','orders','order_items','settings',
    'channel_messages','payments','webhook_events','chat_carts','purchase_orders','purchase_order_lines','purchase_receipts','invoice_counters','invoices','stock_counts','stock_count_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id uuid REFERENCES tenants(id)', t);
    EXECUTE format('UPDATE %I SET tenant_id = (SELECT id FROM tenants WHERE slug = ''default'')', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT current_tenant()', t);
    EXECUTE format('CREATE INDEX %I ON %I (tenant_id)', 'idx_' || t || '_tenant', t);
  END LOOP;
END $$;

-- Natural keys become unique per tenant. (Emails stay globally unique: a login finds its tenant from the email.)
ALTER TABLE categories DROP CONSTRAINT categories_name_key,             ADD CONSTRAINT categories_tenant_name_key UNIQUE (tenant_id, name);
ALTER TABLE products DROP CONSTRAINT products_sku_key,                  ADD CONSTRAINT products_tenant_sku_key UNIQUE (tenant_id, sku);
DROP INDEX uq_products_barcode;  CREATE UNIQUE INDEX uq_products_barcode ON products (tenant_id, barcode) WHERE barcode IS NOT NULL;
ALTER TABLE warehouses DROP CONSTRAINT warehouses_code_key,             ADD CONSTRAINT warehouses_tenant_code_key UNIQUE (tenant_id, code);
ALTER TABLE customers DROP CONSTRAINT customers_channel_channel_user_id_key, ADD CONSTRAINT customers_tenant_channel_key UNIQUE (tenant_id, channel, channel_user_id);
ALTER TABLE channel_messages DROP CONSTRAINT channel_messages_external_id_key, ADD CONSTRAINT channel_messages_tenant_external_key UNIQUE (tenant_id, external_id);
DROP INDEX uq_messages_provider_id; CREATE UNIQUE INDEX uq_messages_provider_id ON channel_messages (tenant_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL;
ALTER TABLE settings DROP CONSTRAINT settings_pkey,                     ADD PRIMARY KEY (tenant_id, key);
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_pkey,         ADD PRIMARY KEY (tenant_id, provider, event_id);
ALTER TABLE invoice_counters DROP CONSTRAINT invoice_counters_pkey,     ADD PRIMARY KEY (tenant_id, fy);
ALTER TABLE invoices DROP CONSTRAINT invoices_fy_seq_key,               ADD CONSTRAINT invoices_tenant_fy_seq_key UNIQUE (tenant_id, fy, seq);
ALTER TABLE invoices DROP CONSTRAINT invoices_number_key,               ADD CONSTRAINT invoices_tenant_number_key UNIQUE (tenant_id, number);

-- Human numbers (orders, purchase orders, stock counts) count per tenant. A trigger fills `number`, so no service changes.
CREATE TABLE tenant_counters (tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, kind text NOT NULL,
  last_number int NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, kind));
INSERT INTO tenant_counters (tenant_id, kind, last_number)
SELECT t.id, k.kind, k.n FROM tenants t, (VALUES ('order', (SELECT COALESCE(max(number), 0) FROM orders)),
  ('purchase_order', (SELECT COALESCE(max(number), 0) FROM purchase_orders)), ('stock_count', (SELECT COALESCE(max(number), 0) FROM stock_counts))) AS k(kind, n)
WHERE t.slug = 'default';

CREATE FUNCTION next_tenant_number(t uuid, k text) RETURNS int LANGUAGE sql AS $$
  INSERT INTO tenant_counters (tenant_id, kind, last_number) VALUES (t, k, 1)
  ON CONFLICT (tenant_id, kind) DO UPDATE SET last_number = tenant_counters.last_number + 1 RETURNING last_number
$$;
CREATE FUNCTION assign_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.number IS NULL THEN NEW.number := next_tenant_number(NEW.tenant_id, TG_ARGV[0]); END IF;
  RETURN NEW;
END $$;

ALTER TABLE orders ALTER COLUMN number DROP DEFAULT,           DROP CONSTRAINT orders_number_key,           ADD CONSTRAINT orders_tenant_number_key UNIQUE (tenant_id, number);
ALTER TABLE purchase_orders ALTER COLUMN number DROP DEFAULT,  DROP CONSTRAINT purchase_orders_number_key,  ADD CONSTRAINT purchase_orders_tenant_number_key UNIQUE (tenant_id, number);
ALTER TABLE stock_counts ALTER COLUMN number DROP DEFAULT,     DROP CONSTRAINT stock_counts_number_key,     ADD CONSTRAINT stock_counts_tenant_number_key UNIQUE (tenant_id, number);
CREATE TRIGGER trg_orders_number BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION assign_number('order');
CREATE TRIGGER trg_po_number BEFORE INSERT ON purchase_orders FOR EACH ROW EXECUTE FUNCTION assign_number('purchase_order');
CREATE TRIGGER trg_count_number BEFORE INSERT ON stock_counts FOR EACH ROW EXECUTE FUNCTION assign_number('stock_count');
