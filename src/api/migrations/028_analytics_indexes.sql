-- Release 5 (T111): indexes for the analytics queries (each is per business, then by time).
CREATE INDEX IF NOT EXISTS idx_orders_tenant_created ON orders (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_in_created ON channel_messages (tenant_id, created_at) WHERE direction = 'in';
CREATE INDEX IF NOT EXISTS idx_movements_out_product ON stock_movements (product_id, created_at DESC) WHERE type = 'OUT';
