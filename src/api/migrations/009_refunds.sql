-- Release 4 (T83): automatic refunds through the Razorpay API. The order stays REFUND_DUE until the signed
-- `refund.processed` webhook arrives (D-015); refund state lives on the payment.
ALTER TABLE payments
  ADD COLUMN refund_id text,
  ADD COLUMN refund_status text CHECK (refund_status IN ('PENDING','PROCESSED','FAILED')),
  ADD COLUMN refund_error text,
  ADD COLUMN refund_attempts int NOT NULL DEFAULT 0,   -- part of the Razorpay idempotency key: a definite failure gets a fresh key, an unknown outcome reuses it
  ADD COLUMN paid_cents int;                           -- what Razorpay actually captured (can differ from amount_cents when flagged); NULL on older rows
CREATE INDEX idx_payments_provider_payment ON payments(provider_payment_id) WHERE provider_payment_id IS NOT NULL;
