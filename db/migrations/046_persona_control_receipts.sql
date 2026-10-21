ALTER TABLE tasks DROP CONSTRAINT tasks_control_kind_check;
ALTER TABLE tasks ADD CHECK(control_kind IN ('STOP','CLARIFICATION_REPLY','PERSONA'));
CREATE TABLE persona_control_responses (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,run_id uuid NOT NULL,event_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('SAVED','VIEW','HELP','CLARIFY','DENIED','CONFLICT','LOCKED','UNAVAILABLE')),
 scope_kind text,scope_id text,revision_id uuid,version_no bigint,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),auth_epoch bigint NOT NULL,policy_version text NOT NULL,audience jsonb NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,run_id),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,event_id) REFERENCES event_inbox(tenant_id,id),
 FOREIGN KEY(tenant_id,revision_id) REFERENCES persona_revisions(tenant_id,id),
 CHECK((scope_kind IS NULL)=(scope_id IS NULL)),CHECK(scope_kind IS NULL OR scope_kind IN ('USER','GROUP','GLOBAL')),
 CHECK((outcome IN ('SAVED','VIEW'))=(scope_kind IS NOT NULL)),CHECK((outcome IN ('SAVED','VIEW'))=(version_no IS NOT NULL)),
 CHECK(version_no IS NULL OR version_no>=0),CHECK(outcome<>'SAVED' OR version_no>0 AND revision_id IS NOT NULL),
 CHECK(outcome IN ('SAVED','VIEW') OR revision_id IS NULL)
);
ALTER TABLE persona_control_responses ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_control_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON persona_control_responses USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON persona_control_responses TO oa_runtime;GRANT SELECT ON persona_control_responses TO oa_app;
