-- Release 4 (T69): purchase orders. Stock is only ever received through StockService (docs/3_SCHEMAS.md 3.19).
CREATE TABLE purchase_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number serial UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id), warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  notes text NOT NULL DEFAULT '', created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE purchase_order_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id),
  quantity int NOT NULL CHECK (quantity > 0), received_quantity int NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  unit_cost_cents int NOT NULL CHECK (unit_cost_cents >= 0), CHECK (received_quantity <= quantity), UNIQUE (po_id, product_id));
-- One row per receive call: a repeated receipt id is a no-op (idempotent).
CREATE TABLE purchase_receipts (receipt_id text NOT NULL, po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (po_id, receipt_id));
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_pol_product ON purchase_order_lines(product_id);
