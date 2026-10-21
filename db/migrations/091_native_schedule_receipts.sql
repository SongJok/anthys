ALTER TABLE tasks DROP CONSTRAINT tasks_control_kind_check;
ALTER TABLE tasks ADD CHECK(control_kind IN ('STOP','CLARIFICATION_REPLY','PERSONA','MEMORY','REMINDER','SCHEDULE'));
CREATE TABLE schedule_control_responses (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,run_id uuid NOT NULL,event_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('CREATED','PAUSED','CANCELLED','CLARIFY','DENIED')),schedule_id uuid,revision bigint,
 receipt_ref jsonb NOT NULL,receipt_hash text NOT NULL,content_hash text NOT NULL,auth_epoch bigint NOT NULL,policy_version text NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,event_id),UNIQUE(tenant_id,run_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,event_id) REFERENCES event_inbox(tenant_id,id),
 FOREIGN KEY(tenant_id,schedule_id,owner_id) REFERENCES schedules(tenant_id,id,owner_id),CHECK((schedule_id IS NULL)=(revision IS NULL)),CHECK((outcome IN ('CREATED','PAUSED','CANCELLED'))=(schedule_id IS NOT NULL))
);
ALTER TABLE schedule_control_responses ENABLE ROW LEVEL SECURITY;ALTER TABLE schedule_control_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY schedule_control_owner ON schedule_control_responses USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON schedule_control_responses TO oa_runtime;
CREATE TRIGGER schedule_control_response_immutable BEFORE UPDATE OR DELETE ON schedule_control_responses FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
