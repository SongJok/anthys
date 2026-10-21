-- Deterministic owner-only reminders. No external send is performed by migration.
ALTER TABLE tasks DROP CONSTRAINT tasks_control_kind_check;
ALTER TABLE tasks ADD CHECK(control_kind IN ('STOP','CLARIFICATION_REPLY','PERSONA','MEMORY','REMINDER'));
CREATE FUNCTION public.oa_schedule_lifecycle_open() RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT nullif(current_setting('app.trial_profile_hash',true),'') IS NULL AND nullif(current_setting('app.formal_profile_hash',true),'') IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.one_shot_trials WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 AND NOT EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
$$;
REVOKE ALL ON FUNCTION public.oa_schedule_lifecycle_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_schedule_lifecycle_open() TO oa_runtime;
CREATE TABLE schedules (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),state text NOT NULL CHECK(state IN ('ACTIVE','PAUSED','CANCELLED','COMPLETED','BLOCKED')),
 payload_ref jsonb NOT NULL,payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 auth_epoch bigint NOT NULL,policy_version text NOT NULL,next_due_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),
 CHECK(state<>'ACTIVE' OR next_due_at IS NOT NULL)
);
CREATE INDEX schedules_due ON schedules(tenant_id,owner_id,next_due_at,id) WHERE state='ACTIVE';
CREATE TABLE schedule_occurrences (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,schedule_id uuid NOT NULL,revision bigint NOT NULL,
 scheduled_at timestamptz NOT NULL,state text NOT NULL CHECK(state IN ('QUEUED','STAGED','MISSED','REVOKED')),
 task_id uuid,run_id uuid,delivery_id uuid,content_hash text,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,schedule_id,revision,scheduled_at),UNIQUE(tenant_id,run_id),
 FOREIGN KEY(tenant_id,schedule_id,owner_id) REFERENCES schedules(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,delivery_id) REFERENCES deliveries(tenant_id,id),
 CHECK((task_id IS NULL)=(run_id IS NULL)),CHECK(state<>'STAGED' OR task_id IS NOT NULL AND delivery_id IS NOT NULL AND content_hash IS NOT NULL)
);
CREATE INDEX schedule_occurrences_pending ON schedule_occurrences(tenant_id,owner_id,created_at,id) WHERE state='QUEUED';
CREATE TABLE schedule_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,schedule_id uuid NOT NULL,intent_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,schedule_id,owner_id) REFERENCES schedules(tenant_id,id,owner_id)
);
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;ALTER TABLE schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_occurrences ENABLE ROW LEVEL SECURITY;ALTER TABLE schedule_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE schedule_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY schedule_owner ON schedules USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY occurrence_owner ON schedule_occurrences USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY schedule_request_owner ON schedule_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON schedules,schedule_occurrences TO oa_runtime;
GRANT SELECT,INSERT ON schedule_requests TO oa_runtime;
CREATE TRIGGER schedule_request_immutable BEFORE UPDATE OR DELETE ON schedule_requests FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
