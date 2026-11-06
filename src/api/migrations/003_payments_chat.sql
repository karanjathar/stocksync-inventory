-- Release 2: payments, webhook idempotency and chat carts (docs/3_SCHEMAS.md §3.6).
ALTER TABLE orders
  ADD COLUMN payment_method text NOT NULL DEFAULT 'COD' CHECK (payment_method IN ('COD','ONLINE')),
  ADD COLUMN payment_status text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PAID','REFUND_DUE')),
  ADD COLUMN public_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;     -- unguessable id for /shop/order/<token>

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'razorpay',
  provider_ref text NOT NULL UNIQUE,                 -- plink_xxx
  reference_id text NOT NULL UNIQUE,                 -- sent to Razorpay, e.g. ORD-42-1a2b
  status text NOT NULL CHECK (status IN ('CREATED','PAID','EXPIRED','CANCELLED')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL,
  short_url text NOT NULL,
  provider_payment_id text,                          -- pay_xxx once paid
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX payments_one_open_per_order ON payments(order_id) WHERE status = 'CREATED';

CREATE TABLE webhook_events (provider text NOT NULL, event_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id));

CREATE TABLE chat_carts (customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  items jsonb NOT NULL DEFAULT '[]',                 -- [{ "productId": uuid, "quantity": int }]
  updated_at timestamptz NOT NULL DEFAULT now());
