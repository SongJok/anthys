ALTER TABLE tasks DROP CONSTRAINT tasks_control_kind_check;
ALTER TABLE tasks ADD CHECK(control_kind IN ('STOP','CLARIFICATION_REPLY','PERSONA','MEMORY'));
CREATE TABLE memory_control_responses (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,run_id uuid NOT NULL,event_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('SAVED','CORRECTED','DELETED','HELP','DENIED','NOT_FOUND','CONFLICT','INVALID','UNAVAILABLE')),
 memory_id uuid,revision_id uuid,version_no bigint,
 corp_id text NOT NULL CHECK(length(corp_id) BETWEEN 1 AND 512),robot_code text NOT NULL CHECK(length(robot_code) BETWEEN 1 AND 512),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),auth_epoch bigint NOT NULL,policy_version text NOT NULL,audience jsonb NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,run_id),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,event_id,owner_id) REFERENCES event_inbox(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,memory_id,owner_id) REFERENCES memory_items(tenant_id,id,owner_id),
 CHECK((outcome IN ('SAVED','CORRECTED','DELETED'))=(memory_id IS NOT NULL)),CHECK((memory_id IS NULL)=(version_no IS NULL)),
 CHECK((outcome IN ('SAVED','CORRECTED'))=(revision_id IS NOT NULL)),CHECK(version_no IS NULL OR version_no>0)
);
ALTER TABLE memory_control_responses ENABLE ROW LEVEL SECURITY;ALTER TABLE memory_control_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON memory_control_responses USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_memory_owner(owner_id)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_memory_owner(owner_id));
GRANT SELECT,INSERT ON memory_control_responses TO oa_runtime;GRANT SELECT ON memory_control_responses TO oa_app;
