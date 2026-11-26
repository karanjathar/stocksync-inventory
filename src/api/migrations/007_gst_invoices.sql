-- Release 4 (T73): GST. HSN/SAC code and GST rate per product (basis points), buyer GSTIN/state, gapless invoice numbering.
ALTER TABLE products ADD COLUMN hsn_code text, ADD COLUMN gst_rate_bp int NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 2800);
ALTER TABLE customers ADD COLUMN gstin text, ADD COLUMN state_code text;
-- One row per financial year ('2026-27'); locked FOR UPDATE inside the issuing transaction so numbers are gapless (D-014).
CREATE TABLE invoice_counters (fy text PRIMARY KEY, last_number int NOT NULL);
CREATE TABLE invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  fy text NOT NULL, seq int NOT NULL, number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','VOID')),
  issued_at timestamptz NOT NULL DEFAULT now(), snapshot jsonb NOT NULL,
  taxable_cents int NOT NULL, tax_cents int NOT NULL, total_cents int NOT NULL, UNIQUE (fy, seq));
