CREATE TABLE provider_journals (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,seq bigint NOT NULL,ciphertext_ref text NOT NULL,key_version text NOT NULL,expires_at timestamptz NOT NULL,session_no bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,run_id,seq),FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE provider_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_journals FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON provider_journals USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON provider_journals TO oa_runtime;
CREATE TABLE tool_actions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,logical_action_key text NOT NULL,args_hash text NOT NULL,state text NOT NULL CHECK(state IN ('PREPARED','APPROVAL_REQUIRED','APPROVED','EXECUTING','VERIFIED','APPLIED_UNVERIFIED','FAILED','UNKNOWN','CANCELLED')),provider_id text NOT NULL,result jsonb,tool_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,logical_action_key),FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE tool_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON tool_actions USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tool_actions TO oa_runtime;
GRANT SELECT ON tool_actions TO oa_app;
CREATE INDEX journal_expiry ON provider_journals(expires_at);
CREATE INDEX action_unknown ON tool_actions(tenant_id,created_at) WHERE state IN ('UNKNOWN','EXECUTING');
