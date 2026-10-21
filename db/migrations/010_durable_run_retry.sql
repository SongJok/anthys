ALTER TABLE runs ADD COLUMN retry_due_at timestamptz;
ALTER TABLE runs ADD COLUMN retry_generation bigint NOT NULL DEFAULT 0 CHECK(retry_generation>=0);
ALTER TABLE runs ADD COLUMN retry_attempts int NOT NULL DEFAULT 0 CHECK(retry_attempts>=0);
CREATE INDEX runs_retry_due ON runs(tenant_id,owner_id,retry_due_at,id) WHERE status='RETRY_SCHEDULED';
