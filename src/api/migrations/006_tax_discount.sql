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
