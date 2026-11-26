-- Release 5 (T99): paid plans through Razorpay Subscriptions on the PLATFORM's own Razorpay account.
-- A business can read its subscription but never write it: the state changes only from signed subscription.* webhooks handled by the
-- platform role (and the two narrow functions below, which only ever touch the caller's own row and never grant a paid state).
ALTER TABLE plans ADD COLUMN razorpay_plan_id text UNIQUE;  -- set by the operator; the amount lives in Razorpay's plan, never in a request

CREATE TABLE subscriptions (tenant_id uuid PRIMARY KEY DEFAULT current_tenant() REFERENCES tenants(id),
  razorpay_subscription_id text NOT NULL UNIQUE, plan_code text NOT NULL REFERENCES plans(code), pending_plan_code text REFERENCES plans(code),
  status text NOT NULL CHECK (status IN ('CREATED', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED')),
  short_url text, trial_ends_at timestamptz, trial_used boolean NOT NULL DEFAULT false, current_period_end timestamptz, grace_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON subscriptions FOR SELECT TO stocksync_app USING (tenant_id = current_tenant());
CREATE POLICY platform_all ON subscriptions TO stocksync_platform USING (true) WITH CHECK (true);
REVOKE ALL ON subscriptions FROM stocksync_app;
GRANT SELECT ON subscriptions TO stocksync_app;
GRANT SELECT, INSERT, UPDATE ON subscriptions TO stocksync_platform;

-- Webhook event ids already applied (idempotency). Platform only.
CREATE TABLE billing_events (event_id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON billing_events FROM stocksync_app;
GRANT SELECT, INSERT, DELETE ON billing_events TO stocksync_platform;

-- A business that has just created a Razorpay subscription records it as CREATED (not yet authorised, nothing paid is unlocked).
-- A live subscription cannot be replaced this way (unauthorised, cancelled and expired ones can); the trial flag survives so a trial is only ever given once.
CREATE FUNCTION billing_register(p_subscription text, p_plan text, p_short_url text, p_trial_end timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cur subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO cur FROM subscriptions WHERE tenant_id = current_tenant() FOR UPDATE;
  IF FOUND AND cur.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE') THEN RAISE EXCEPTION 'subscription already live' USING ERRCODE = '23505'; END IF;
  INSERT INTO subscriptions (tenant_id, razorpay_subscription_id, plan_code, status, short_url, trial_ends_at, trial_used)
    VALUES (current_tenant(), p_subscription, p_plan, 'CREATED', p_short_url, p_trial_end, COALESCE(cur.trial_used, false) OR p_trial_end IS NOT NULL)
    ON CONFLICT (tenant_id) DO UPDATE SET razorpay_subscription_id = EXCLUDED.razorpay_subscription_id, plan_code = EXCLUDED.plan_code, pending_plan_code = NULL,
      status = 'CREATED', short_url = EXCLUDED.short_url, trial_ends_at = EXCLUDED.trial_ends_at, trial_used = EXCLUDED.trial_used,
      current_period_end = NULL, grace_ends_at = NULL, cancel_at_period_end = false, updated_at = now();
END $$;

-- Records what the business asked for after it has asked Razorpay; the plan itself still changes only from a webhook.
CREATE FUNCTION billing_note_request(p_pending_plan text, p_cancel boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE subscriptions SET pending_plan_code = COALESCE(p_pending_plan, pending_plan_code), cancel_at_period_end = cancel_at_period_end OR p_cancel, updated_at = now()
  WHERE tenant_id = current_tenant() AND status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
$$;
REVOKE ALL ON FUNCTION billing_register(text, text, text, timestamptz), billing_note_request(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_register(text, text, text, timestamptz), billing_note_request(text, boolean) TO stocksync_app;
