-- Release 5 (T92): jobs remember their business and run as it; the platform role can read queue health (no payloads of business data tables).
ALTER TABLE jobs ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE jobs SET tenant_id = '00000000-0000-4000-8000-000000000001';   -- everything queued so far belongs to the original business
CREATE INDEX idx_jobs_tenant ON jobs(tenant_id);
-- One open job per (business, kind, dedupe key); jobs without a business (platform work) share the nil id.
DROP INDEX uq_jobs_dedupe;
CREATE UNIQUE INDEX uq_jobs_dedupe ON jobs ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), kind, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');
GRANT SELECT ON jobs, worker_heartbeats TO stocksync_platform;
