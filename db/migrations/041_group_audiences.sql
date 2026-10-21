CREATE TABLE dws_group_scopes (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,conversation_external_id text NOT NULL,
 info_profile jsonb NOT NULL,approved_bots jsonb NOT NULL,
 binary_hash text NOT NULL,members_schema_hash text NOT NULL,info_schema_hash text NOT NULL,contract_hash text NOT NULL,
 authorization_review_ref text NOT NULL CHECK(length(authorization_review_ref)>0),directory_review_ref text NOT NULL CHECK(length(directory_review_ref)>0),
 expires_at timestamptz NOT NULL,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX current_group_scope ON dws_group_scopes(tenant_id,owner_id,conversation_external_id) WHERE revoked_at IS NULL;
ALTER TABLE dws_group_scopes ENABLE ROW LEVEL SECURITY;ALTER TABLE dws_group_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON dws_group_scopes USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON dws_group_scopes TO oa_runtime;
CREATE TABLE group_directory_bindings (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,scope_id uuid NOT NULL,
 open_dingtalk_id text NOT NULL,user_id uuid NOT NULL,external_user_id text NOT NULL,user_auth_epoch bigint NOT NULL,
 directory_authority_ref text NOT NULL CHECK(length(directory_authority_ref)>0),expires_at timestamptz NOT NULL,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,scope_id,owner_id) REFERENCES dws_group_scopes(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX current_group_open_id ON group_directory_bindings(tenant_id,scope_id,open_dingtalk_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX current_group_user_id ON group_directory_bindings(tenant_id,scope_id,user_id) WHERE revoked_at IS NULL;
ALTER TABLE group_directory_bindings ENABLE ROW LEVEL SECURITY;ALTER TABLE group_directory_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON group_directory_bindings USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON group_directory_bindings TO oa_runtime;
CREATE TABLE run_group_audiences (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,task_id uuid NOT NULL,
 scope_id uuid NOT NULL,scope_version bigint NOT NULL,identity_id uuid NOT NULL,authorization_version bigint NOT NULL,
 proof_ref jsonb NOT NULL,proof_hash text NOT NULL CHECK(proof_hash ~ '^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,run_id,owner_id),FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,scope_id,owner_id) REFERENCES dws_group_scopes(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,identity_id) REFERENCES dws_identities(tenant_id,id)
);
ALTER TABLE run_group_audiences ENABLE ROW LEVEL SECURITY;ALTER TABLE run_group_audiences FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON run_group_audiences USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON run_group_audiences TO oa_runtime;
ALTER TABLE runs ADD COLUMN group_audience_id uuid;
ALTER TABLE runs ADD FOREIGN KEY(tenant_id,group_audience_id,id,owner_id) REFERENCES run_group_audiences(tenant_id,id,run_id,owner_id);
