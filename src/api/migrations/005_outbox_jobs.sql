-- Release 3 (T59): durable outbound messages (outbox), job queue, worker heartbeat, maintenance log.
ALTER TABLE channel_messages
  ADD COLUMN IF NOT EXISTS payload jsonb,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS status_at timestamptz,
  ADD COLUMN IF NOT EXISTS event text;
-- Outbound status vocabulary: queued | sent | delivered | read | failed | skipped. Legacy 'ok' means sent.
UPDATE channel_messages SET status = 'sent' WHERE direction = 'out' AND status = 'ok';
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_provider_id ON channel_messages(channel, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_out_status ON channel_messages(status) WHERE direction = 'out';

CREATE TABLE IF NOT EXISTS jobs (id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text, run_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 6,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
  locked_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_dedupe ON jobs(kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(run_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS worker_heartbeats (worker_id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS maintenance_runs (task text PRIMARY KEY, ran_at timestamptz NOT NULL, result jsonb NOT NULL);
