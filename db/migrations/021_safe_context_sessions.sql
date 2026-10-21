ALTER TABLE runs ADD COLUMN provider_session_no bigint NOT NULL DEFAULT 1 CHECK(provider_session_no BETWEEN 1 AND 32);
ALTER TABLE tool_actions ADD COLUMN capability_id text,ADD COLUMN binding_hash text,ADD COLUMN risk text CHECK(risk IN ('READ','PERSONAL_WRITE','SHARED_WRITE','SENSITIVE','FORBIDDEN')),ADD COLUMN resource_id text,ADD COLUMN input_ref jsonb,ADD COLUMN execution_auth_epoch bigint,ADD COLUMN execution_policy_version text,ADD COLUMN execution_audience jsonb;
CREATE TABLE context_checkpoints (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,session_no bigint NOT NULL,reason text NOT NULL CHECK(reason IN ('CONTEXT_LIMIT','JOURNAL_EXPIRED','AUTHORIZATION_CHANGED')),
 checkpoint_ref jsonb NOT NULL,key_version text NOT NULL,source_max_seq bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,run_id,session_no),FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
GRANT SELECT,INSERT,DELETE ON context_checkpoints TO oa_runtime;
ALTER TABLE context_checkpoints ENABLE ROW LEVEL SECURITY;ALTER TABLE context_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON context_checkpoints USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE task_attachment_dependencies DROP CONSTRAINT task_attachment_dependencies_pkey;
ALTER TABLE task_attachment_dependencies ADD COLUMN dependency_id uuid NOT NULL DEFAULT gen_random_uuid(),ADD COLUMN run_id uuid,ADD COLUMN session_no bigint NOT NULL DEFAULT 1;
UPDATE task_attachment_dependencies d SET run_id=(SELECT r.id FROM runs r WHERE r.tenant_id=d.tenant_id AND r.task_id=d.task_id ORDER BY r.created_at,r.id LIMIT 1);
ALTER TABLE task_attachment_dependencies ADD PRIMARY KEY(tenant_id,dependency_id),ADD UNIQUE(tenant_id,run_id,session_no,attachment_id),ADD FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id);
ALTER TABLE deliveries ADD COLUMN source_run_id uuid,ADD COLUMN source_session_no bigint;
ALTER TABLE deliveries ADD FOREIGN KEY(tenant_id,source_run_id) REFERENCES runs(tenant_id,id);
