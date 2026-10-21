-- Protected task-result exports. This migration installs no external sender,
-- grant, operator approval, font configuration or enterprise connector.
CREATE TABLE artifacts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,run_id uuid NOT NULL,
 source_session_no bigint NOT NULL CHECK(source_session_no BETWEEN 1 AND 32),source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),auth_epoch bigint NOT NULL,
 format text NOT NULL CHECK(format IN ('md','txt','csv','json','html','xlsx','docx','pdf')),
 state text NOT NULL CHECK(state IN ('PREPARING','READY','FAILED','REVOKED')),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 storage_key text NOT NULL,mime text,file_name text,byte_size bigint CHECK(byte_size BETWEEN 1 AND 8388608),sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 classification text NOT NULL CHECK(classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
 source_verification text NOT NULL DEFAULT 'UNVERIFIED' CHECK(source_verification IN ('VERIFIED','PARTIAL','UNVERIFIED')),
 inspection jsonb,last_error text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),file_removed_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,task_id,request_key),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),
 CHECK(state<>'READY' OR (mime IS NOT NULL AND file_name IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL AND inspection IS NOT NULL))
);
CREATE INDEX artifacts_task ON artifacts(tenant_id,owner_id,task_id,created_at,id);
CREATE INDEX artifacts_cleanup ON artifacts(tenant_id,owner_id,state,expires_at) WHERE file_removed_at IS NULL;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON artifacts USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON artifacts TO oa_runtime;

CREATE TABLE artifact_download_tickets (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,artifact_id uuid NOT NULL,session_id uuid NOT NULL,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),artifact_hash text NOT NULL CHECK(artifact_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),consumed_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,token_hash),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),FOREIGN KEY(tenant_id,session_id) REFERENCES sessions(tenant_id,id)
);
ALTER TABLE artifact_download_tickets ENABLE ROW LEVEL SECURITY;ALTER TABLE artifact_download_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON artifact_download_tickets USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON artifact_download_tickets TO oa_runtime;
