-- Release 3, purchasing (docs/3_SCHEMAS.md §3.15). Money is integer minor units; stock changes only through StockService.
ALTER TABLE products
  ADD COLUMN reorder_quantity integer NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
  ADD COLUMN preferred_supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number serial UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  expected_date date,
  notes text NOT NULL DEFAULT '',
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (supplier_id);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (status);

CREATE TABLE purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  received_quantity integer NOT NULL DEFAULT 0,
  unit_cost_cents integer NOT NULL CHECK (unit_cost_cents >= 0),
  UNIQUE (purchase_order_id, product_id),
  CHECK (received_quantity BETWEEN 0 AND quantity)
);

CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number serial UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  purchase_order_id uuid REFERENCES purchase_orders(id),
  status text NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PARTIAL','PAID','VOID')),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  paid_cents integer NOT NULL DEFAULT 0,
  due_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (paid_cents BETWEEN 0 AND total_cents)
);

CREATE TABLE bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  request_id text NOT NULL UNIQUE,
  method text NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now()
);
