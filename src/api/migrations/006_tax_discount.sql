-- Release 3, tax and discounts (docs/3_SCHEMAS.md §3.16). Rates are basis points (18% = 1800); money is integer minor units.
CREATE TABLE tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  rate_bp integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true
);

ALTER TABLE products ADD COLUMN tax_rate_id uuid REFERENCES tax_rates(id);

ALTER TABLE orders
  ADD COLUMN discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  ADD COLUMN tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  ADD COLUMN subtotal_cents integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0);
-- Existing orders had no tax or discount: their subtotal is their total.
UPDATE orders SET subtotal_cents = total_cents;

ALTER TABLE order_items
  ADD COLUMN tax_rate_bp integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  ADD COLUMN discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);

-- Per-line results are stored so documents never have to re-derive them.
ALTER TABLE order_items
  ADD COLUMN tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  ADD COLUMN total_cents integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0);
UPDATE order_items SET total_cents = unit_price_cents * quantity;
ALTER TABLE orders ADD COLUMN prices_include_tax boolean NOT NULL DEFAULT false;

-- Invoices (T65): an immutable snapshot issued when an order is confirmed.
CREATE TABLE invoice_counters (year integer PRIMARY KEY, last integer NOT NULL CHECK (last >= 0));

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'VOID')),
  currency text NOT NULL,
  inclusive boolean NOT NULL,
  seller jsonb NOT NULL,
  customer jsonb NOT NULL,
  lines jsonb NOT NULL,
  subtotal_cents integer NOT NULL,
  discount_cents integer NOT NULL,
  tax_cents integer NOT NULL,
  total_cents integer NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz
);
CREATE INDEX invoices_issued_idx ON invoices (issued_at DESC);

-- Only ISSUED -> VOID (with voided_at) may ever change; nothing is deleted.
CREATE FUNCTION invoices_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices cannot be deleted' USING ERRCODE = '23000';
  END IF;
  IF OLD.status = 'VOID'
     OR NEW.status <> 'VOID'
     OR (to_jsonb(NEW) - 'status' - 'voided_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'voided_at') THEN
    RAISE EXCEPTION 'invoices are immutable once issued (only voiding is allowed)' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_immutable();

-- Bin/shelf location per product and warehouse, shown on picklists (T66). Not a quantity: StockService sets it.
ALTER TABLE stock_levels ADD COLUMN bin text CHECK (bin IS NULL OR length(bin) BETWEEN 1 AND 40);

-- Sales returns and credit notes (T67).
CREATE TABLE credit_note_counters (year integer PRIMARY KEY, last integer NOT NULL CHECK (last >= 0));

CREATE TABLE sales_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number serial UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  credit_subtotal_cents integer NOT NULL CHECK (credit_subtotal_cents >= 0),
  credit_tax_cents integer NOT NULL CHECK (credit_tax_cents >= 0),
  credit_total_cents integer NOT NULL CHECK (credit_total_cents >= 0),
  request_id text NOT NULL UNIQUE,
  reason text NOT NULL DEFAULT '',
  refund_status text NOT NULL CHECK (refund_status IN ('NOT_REQUIRED', 'REFUND_DUE', 'REFUNDED')),
  refund_cents integer NOT NULL DEFAULT 0 CHECK (refund_cents >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_returns_order_idx ON sales_returns (order_id);

CREATE TABLE sales_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_return_id uuid NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  credit_tax_cents integer NOT NULL CHECK (credit_tax_cents >= 0),
  credit_total_cents integer NOT NULL CHECK (credit_total_cents >= 0),
  UNIQUE (sales_return_id, order_item_id)
);

CREATE TABLE credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_return_id uuid NOT NULL UNIQUE REFERENCES sales_returns(id),
  number text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id),
  invoice_number text,
  currency text NOT NULL,
  inclusive boolean NOT NULL,
  seller jsonb NOT NULL,
  customer jsonb NOT NULL,
  lines jsonb NOT NULL,
  reason text NOT NULL DEFAULT '',
  subtotal_cents integer NOT NULL,
  tax_cents integer NOT NULL,
  total_cents integer NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION credit_notes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit notes cannot be deleted' USING ERRCODE = '23000';
  END IF;
  RAISE EXCEPTION 'credit notes are immutable once issued' USING ERRCODE = '23000';
END $$;
CREATE TRIGGER credit_notes_immutable BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION credit_notes_immutable();

-- Purchase returns and debit notes (T68). A debit lowers what is owed on a bill without rewriting the bill's total.
ALTER TABLE bills ADD COLUMN debit_cents integer NOT NULL DEFAULT 0 CHECK (debit_cents >= 0);
ALTER TABLE bills ADD CONSTRAINT bills_covered CHECK (paid_cents + debit_cents <= total_cents);

CREATE TABLE debit_note_counters (year integer PRIMARY KEY, last integer NOT NULL CHECK (last >= 0));

CREATE TABLE purchase_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number serial UNIQUE,
  debit_note_number text NOT NULL UNIQUE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  debit_total_cents integer NOT NULL CHECK (debit_total_cents >= 0),
  applied_cents integer NOT NULL CHECK (applied_cents >= 0),     -- taken off supplier bills
  unapplied_cents integer NOT NULL CHECK (unapplied_cents >= 0), -- bills already paid: the supplier owes us this
  request_id text NOT NULL UNIQUE,
  reason text NOT NULL DEFAULT '',
  snapshot jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_returns_po_idx ON purchase_returns (purchase_order_id);

CREATE TABLE purchase_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_return_id uuid NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  purchase_order_item_id uuid NOT NULL REFERENCES purchase_order_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  debit_cents integer NOT NULL CHECK (debit_cents >= 0),
  UNIQUE (purchase_return_id, purchase_order_item_id)
);

CREATE FUNCTION purchase_returns_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase returns cannot be deleted' USING ERRCODE = '23000';
  END IF;
  RAISE EXCEPTION 'purchase returns are immutable once issued' USING ERRCODE = '23000';
END $$;
CREATE TRIGGER purchase_returns_immutable BEFORE UPDATE OR DELETE ON purchase_returns FOR EACH ROW EXECUTE FUNCTION purchase_returns_immutable();
