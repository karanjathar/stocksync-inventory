-- Release 5 (T93): the public storefront and order/invoice links must find their business from a slug or a token before any tenant context exists.
-- Each function does one narrow lookup as the table owner (SECURITY DEFINER, pinned search_path), returns only ACTIVE businesses, and nothing else.
CREATE FUNCTION tenant_by_slug(p_slug text) RETURNS TABLE (id uuid, slug text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.slug, t.name FROM tenants t WHERE t.slug = p_slug AND t.status = 'ACTIVE'
$$;
CREATE FUNCTION tenant_of_order_token(p_token uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.tenant_id FROM orders o JOIN tenants t ON t.id = o.tenant_id WHERE o.public_token = p_token AND t.status = 'ACTIVE'
$$;
CREATE FUNCTION tenant_of_invoice(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.tenant_id FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = p_id AND t.status = 'ACTIVE'
$$;
REVOKE ALL ON FUNCTION tenant_by_slug(text), tenant_of_order_token(uuid), tenant_of_invoice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_by_slug(text), tenant_of_order_token(uuid), tenant_of_invoice(uuid) TO stocksync_app;
