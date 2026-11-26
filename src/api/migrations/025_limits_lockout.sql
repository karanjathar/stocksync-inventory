-- Release 5 (T105): per-plan request rate, and failed-login tracking for lockout with backoff.
ALTER TABLE plans ADD COLUMN requests_per_minute integer NOT NULL DEFAULT 600 CHECK (requests_per_minute BETWEEN 10 AND 100000);
UPDATE plans SET requests_per_minute = CASE code WHEN 'FREE' THEN 120 WHEN 'PRO' THEN 600 WHEN 'BUSINESS' THEN 3000 ELSE 600 END;

-- One row per account (hash of the email, whether or not such an account exists) or per client address. Holds no personal data and no tenant:
-- it is consulted before anyone is identified, so it must not reveal which emails are real.
CREATE TABLE login_attempts (key text PRIMARY KEY, failures integer NOT NULL, last_failure_at timestamptz NOT NULL, locked_until timestamptz);
REVOKE ALL ON login_attempts FROM stocksync_app, stocksync_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO stocksync_app, stocksync_platform;
