CREATE TABLE attachments (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,source_event_id uuid NOT NULL,source_index int NOT NULL CHECK(source_index>=0),
 file_name text NOT NULL,input_kind text NOT NULL CHECK(input_kind IN ('FILE','PICTURE')),state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','DOWNLOADING','READY','QUARANTINED','REJECTED','RETRYABLE_ERROR')),
 attempt_id uuid,attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0),lease_until timestamptz,next_at timestamptz NOT NULL DEFAULT now(),
 storage_key text,mime text,byte_size bigint CHECK(byte_size>=0),sha256 text,key_version text,inspection_method text,last_error text,
 classification text NOT NULL DEFAULT 'CONFIDENTIAL' CHECK(classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),auth_epoch bigint NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_event_id,source_index),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE ON attachments TO oa_runtime;
GRANT SELECT ON attachments TO oa_app;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON attachments USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE INDEX attachments_task ON attachments(tenant_id,owner_id,task_id,id);
