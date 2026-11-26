-- Release 5 (T90): housekeeping records are per tenant (the scheduler iterates tenants in T92).
ALTER TABLE maintenance_runs ADD COLUMN tenant_id uuid REFERENCES tenants(id);
UPDATE maintenance_runs SET tenant_id = '00000000-0000-4000-8000-000000000001';
ALTER TABLE maintenance_runs ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT current_tenant();
ALTER TABLE maintenance_runs DROP CONSTRAINT maintenance_runs_pkey, ADD PRIMARY KEY (tenant_id, task);
ALTER TABLE maintenance_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON maintenance_runs USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
