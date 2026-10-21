ALTER TABLE attachments ADD COLUMN source_run_id uuid;
ALTER TABLE attachments ADD COLUMN source_run_fence bigint;
ALTER TABLE attachments ADD CONSTRAINT attachments_source_run_fk FOREIGN KEY(tenant_id,source_run_id) REFERENCES runs(tenant_id,id);
-- Legacy read leases have no fence. Restarting a pure download does not repeat a business write.
UPDATE attachments SET state='RETRYABLE_ERROR',lease_until=NULL,next_at=now(),last_error='LEGACY_READ_RESTART_REQUIRED' WHERE state='DOWNLOADING';
