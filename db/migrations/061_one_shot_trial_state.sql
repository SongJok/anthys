-- No activation is performed by this migration. Only an explicit migrator
-- operation can provision a slot. Runtime roles cannot arm or delete one.
CREATE TABLE public.one_shot_trials (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
 owner_id uuid NOT NULL,
 profile_hash text NOT NULL CHECK (length(profile_hash)=64),
 budget_policy_hash text NOT NULL CHECK (length(budget_policy_hash)=64),
 corp_id text NOT NULL, external_user_id text NOT NULL,
 robot_code text NOT NULL, conversation_id text NOT NULL,
 deadline timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'ARMED' CHECK (state IN ('ARMED','BOUND','CLOSED')),
 msg_id text, task_id uuid, run_id uuid,
 bound_at timestamptz, closed_at timestamptz, close_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK ((msg_id IS NULL AND task_id IS NULL AND run_id IS NULL AND bound_at IS NULL)
     OR (msg_id IS NOT NULL AND task_id IS NOT NULL AND run_id IS NOT NULL AND bound_at IS NOT NULL)),
 CHECK (state<>'BOUND' OR task_id IS NOT NULL),
 CHECK ((state='CLOSED')=(closed_at IS NOT NULL AND close_reason IS NOT NULL))
);
ALTER TABLE public.one_shot_trials ENABLE ROW LEVEL SECURITY;
CREATE POLICY trial_namespace ON public.one_shot_trials USING
 (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON public.one_shot_trials TO oa_runtime;

CREATE FUNCTION public.oa_trial_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TRIAL_DELETE_FORBIDDEN'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','msg_id','task_id','run_id','bound_at','closed_at','close_reason'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','msg_id','task_id','run_id','bound_at','closed_at','close_reason'])
 THEN RAISE EXCEPTION 'TRIAL_PROFILE_IMMUTABLE'; END IF;
 IF OLD.state='CLOSED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'TRIAL_CLOSED_IMMUTABLE'; END IF;
 IF OLD.state='BOUND' AND NEW.state NOT IN ('BOUND','CLOSED') THEN RAISE EXCEPTION 'TRIAL_REOPEN_FORBIDDEN'; END IF;
 IF OLD.task_id IS NOT NULL AND (NEW.msg_id,NEW.task_id,NEW.run_id,NEW.bound_at)
    IS DISTINCT FROM (OLD.msg_id,OLD.task_id,OLD.run_id,OLD.bound_at)
 THEN RAISE EXCEPTION 'TRIAL_BINDING_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trial_immutable BEFORE UPDATE OR DELETE ON public.one_shot_trials
FOR EACH ROW EXECUTE FUNCTION public.oa_trial_immutable();
REVOKE ALL ON FUNCTION public.oa_trial_immutable() FROM PUBLIC;
