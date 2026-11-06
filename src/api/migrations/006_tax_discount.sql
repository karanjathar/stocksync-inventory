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
