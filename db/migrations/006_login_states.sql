CREATE TABLE login_states (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL,state_hash text NOT NULL UNIQUE,browser_hash text NOT NULL,redirect_path text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id)
);
ALTER TABLE login_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_states FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON login_states USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON login_states TO oa_app,oa_runtime;
CREATE INDEX login_states_expiry ON login_states(expires_at);
