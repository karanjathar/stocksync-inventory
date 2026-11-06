-- Release 2 (T58): staff can mark a refund as done, so REFUND_DUE flags can be cleared.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('UNPAID', 'PAID', 'REFUND_DUE', 'REFUNDED'));
