CREATE TABLE run_finalizations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,session_no bigint NOT NULL CHECK(session_no BETWEEN 1 AND 32),run_fence bigint NOT NULL CHECK(run_fence>0),
 state text NOT NULL CHECK(state IN ('VERIFIED','PARTIAL','REJECTED')),reason text,plan_ref jsonb NOT NULL,source_hash text NOT NULL,output_hash text,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,run_id,owner_id,session_no),FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),
 CHECK(state='REJECTED' AND output_hash IS NULL OR state<>'REJECTED' AND output_hash IS NOT NULL)
);
ALTER TABLE run_finalizations ENABLE ROW LEVEL SECURITY;ALTER TABLE run_finalizations FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON run_finalizations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON run_finalizations TO oa_runtime;
GRANT SELECT(tenant_id,id,owner_id,run_id,session_no,run_fence,state,reason,source_hash,output_hash,expires_at,created_at) ON run_finalizations TO oa_app;
ALTER TABLE deliveries ADD COLUMN finalization_id uuid;
ALTER TABLE deliveries ADD FOREIGN KEY(tenant_id,finalization_id,source_run_id,owner_id,source_session_no) REFERENCES run_finalizations(tenant_id,id,run_id,owner_id,session_no);
CREATE INDEX finalization_expiry ON run_finalizations(tenant_id,owner_id,expires_at);
