CREATE TABLE capability_bindings (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL,logical_id text NOT NULL,semantic_version text NOT NULL,provider_binding jsonb NOT NULL,schema_hash text NOT NULL,risk text NOT NULL CHECK(risk IN ('READ','PERSONAL_WRITE','SHARED_WRITE','SENSITIVE','FORBIDDEN')),state text NOT NULL CHECK(state IN ('UNCONFIGURED','UNVERIFIED','READY','DEGRADED','BLOCKED','DISABLED')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,logical_id,semantic_version)
);
CREATE TABLE resource_grants (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL,actor_id uuid NOT NULL,capability_id text NOT NULL,resource_id text NOT NULL,audience_kind text NOT NULL CHECK(audience_kind IN ('PRIVATE_USER','GROUP')),audience_id text NOT NULL,classification_ceiling text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,membership_version bigint,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id),UNIQUE(tenant_id,actor_id,capability_id,resource_id,audience_kind,audience_id)
);
CREATE TABLE approvals (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,action_id uuid NOT NULL,approver_id uuid NOT NULL,args_hash text NOT NULL,state text NOT NULL CHECK(state IN ('PENDING','APPROVED','REJECTED','CONSUMED','EXPIRED')),expires_at timestamptz NOT NULL,nonce_hash text NOT NULL,approver_auth_epoch bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,action_id) REFERENCES tool_actions(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,approver_id) REFERENCES users(tenant_id,id),CHECK(owner_id<>approver_id)
);
CREATE TABLE quota_ledger (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,subject text NOT NULL,period text NOT NULL,reservation numeric NOT NULL CHECK(reservation>=0),used numeric CHECK(used>=0),provider_usage jsonb,cost_state text NOT NULL CHECK(cost_state IN ('RESERVED','SETTLED','UNKNOWN','RELEASED')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE ON approvals TO oa_app,oa_runtime;
GRANT SELECT ON capability_bindings,resource_grants,quota_ledger TO oa_app,oa_runtime;
GRANT INSERT,UPDATE ON quota_ledger TO oa_runtime;
ALTER TABLE capability_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON capability_bindings USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE resource_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON resource_grants USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE quota_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON quota_ledger USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON approvals USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND (owner_id=nullif(current_setting('app.actor_id',true),'')::uuid OR approver_id=nullif(current_setting('app.actor_id',true),'')::uuid)) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND (owner_id=nullif(current_setting('app.actor_id',true),'')::uuid OR approver_id=nullif(current_setting('app.actor_id',true),'')::uuid));
