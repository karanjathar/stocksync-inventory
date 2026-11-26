-- Release 4 (T79/T80): product barcodes and stock count sessions.
ALTER TABLE products ADD COLUMN barcode text;
CREATE UNIQUE INDEX uq_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;

CREATE TABLE stock_counts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number serial UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SUBMITTED','CANCELLED')),
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz);
CREATE TABLE stock_count_lines (count_id uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id), counted_quantity int NOT NULL CHECK (counted_quantity >= 0),
  system_quantity int, PRIMARY KEY (count_id, product_id));  -- system_quantity is captured at submit time for the variance report
CREATE INDEX idx_counts_status ON stock_counts(status);
