ALTER TABLE runs ADD UNIQUE(tenant_id,id,owner_id),ADD UNIQUE(tenant_id,id,task_id,owner_id);
ALTER TABLE context_checkpoints ADD COLUMN task_id uuid;
UPDATE context_checkpoints p SET task_id=r.task_id FROM runs r WHERE r.tenant_id=p.tenant_id AND r.id=p.run_id;
ALTER TABLE context_checkpoints ALTER COLUMN task_id SET NOT NULL;
ALTER TABLE context_checkpoints ADD FOREIGN KEY(tenant_id,run_id,task_id,owner_id) REFERENCES runs(tenant_id,id,task_id,owner_id);
ALTER TABLE task_attachment_dependencies ADD FOREIGN KEY(tenant_id,run_id,task_id,owner_id) REFERENCES runs(tenant_id,id,task_id,owner_id);
ALTER TABLE model_stream_progress ADD FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id);
ALTER TABLE tool_actions ADD FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id);
ALTER TABLE provider_journals ADD FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id);
ALTER TABLE run_steps ADD FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id);
-- Pre-session deliveries can be assigned only when there was exactly one completed run
-- and it still has its original session. All other unbound writes remain withheld/unknown.
UPDATE deliveries d SET source_run_id=r.id,source_session_no=1 FROM runs r WHERE d.source_run_id IS NULL AND r.tenant_id=d.tenant_id AND r.task_id=d.task_id AND r.owner_id=d.owner_id AND r.status='SUCCEEDED' AND r.provider_session_no=1 AND (SELECT count(*) FROM runs sibling WHERE sibling.tenant_id=r.tenant_id AND sibling.task_id=r.task_id)=1;
UPDATE deliveries SET state='SUPPRESSED',last_error='LEGACY_DELIVERY_SOURCE_UNBOUND' WHERE source_run_id IS NULL AND state='PENDING';
UPDATE deliveries SET state='UNKNOWN',last_error='LEGACY_DELIVERY_SOURCE_UNBOUND' WHERE source_run_id IS NULL AND state='SENDING';
ALTER TABLE deliveries ADD CHECK((source_run_id IS NULL)=(source_session_no IS NULL)),ADD CHECK(source_session_no IS NULL OR source_session_no BETWEEN 1 AND 32);
ALTER TABLE deliveries ADD FOREIGN KEY(tenant_id,source_run_id,task_id,owner_id) REFERENCES runs(tenant_id,id,task_id,owner_id);
