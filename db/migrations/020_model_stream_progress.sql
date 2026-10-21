CREATE TABLE model_stream_progress (
 tenant_id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,attempt_id uuid NOT NULL,run_fence bigint NOT NULL,
 sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0),content_fragments bigint NOT NULL DEFAULT 0 CHECK(content_fragments>=0),tool_fragments bigint NOT NULL DEFAULT 0 CHECK(tool_fragments>=0),
 phase text NOT NULL CHECK(phase IN ('STARTED','RECEIVING','COMPLETE','INTERRUPTED')),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE ON model_stream_progress TO oa_runtime;
GRANT SELECT ON model_stream_progress TO oa_app;
ALTER TABLE model_stream_progress ENABLE ROW LEVEL SECURITY;ALTER TABLE model_stream_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON model_stream_progress USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
