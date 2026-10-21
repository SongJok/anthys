-- One irreversible runtime attempt for an existing authorized trial. A local
-- directory, copied profile, second host or restarted launcher cannot reset it.
-- This table does not alter the CLOSED trial JSON used by FORMAL snapshots.
CREATE TABLE public.one_shot_trial_executions (
 tenant_id uuid PRIMARY KEY REFERENCES public.one_shot_trials(tenant_id),
 owner_id uuid NOT NULL,
 profile_hash text NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
 execution_token text NOT NULL CHECK(execution_token ~ '^[a-f0-9]{32}$'),
 deadline timestamptz NOT NULL,
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 claimed_txid bigint NOT NULL DEFAULT txid_current(),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id)
);
ALTER TABLE public.one_shot_trial_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY trial_execution_owner ON public.one_shot_trial_executions USING
 (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
REVOKE ALL ON public.one_shot_trial_executions FROM PUBLIC,oa_app,oa_runtime,oa_queue;
GRANT SELECT ON public.one_shot_trial_executions TO oa_runtime;
CREATE FUNCTION public.oa_trial_execution_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'TRIAL_EXECUTION_CLAIM_IMMUTABLE';END $$;
CREATE TRIGGER trial_execution_immutable BEFORE UPDATE OR DELETE ON public.one_shot_trial_executions
FOR EACH ROW EXECUTE FUNCTION public.oa_trial_execution_immutable();
REVOKE ALL ON FUNCTION public.oa_trial_execution_immutable() FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_trial_claim_execution(p_profile_hash text,p_execution_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE slot public.one_shot_trials;claimed boolean;
BEGIN
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR UPDATE;
 IF NOT FOUND OR slot.owner_id IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')::uuid
  OR slot.profile_hash IS DISTINCT FROM p_profile_hash OR slot.profile_hash IS DISTINCT FROM nullif(current_setting('app.trial_profile_hash',true),'')
  OR slot.state<>'ARMED' OR slot.task_id IS NOT NULL OR slot.run_id IS NOT NULL
  OR slot.deadline<=clock_timestamp() OR slot.deadline>slot.created_at+interval '20 minutes'
  OR p_execution_token IS NULL OR p_execution_token !~ '^[a-f0-9]{32}$'
  OR NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id
   WHERE u.tenant_id=slot.tenant_id AND u.id=slot.owner_id AND u.status='ACTIVE' AND u.external_user_id=slot.external_user_id AND t.status='ACTIVE' AND t.corp_id=slot.corp_id)
 THEN RETURN jsonb_build_object('claimed',false,'reason','TRIAL_EXECUTION_NOT_ALLOWED');END IF;
 INSERT INTO public.one_shot_trial_executions(tenant_id,owner_id,profile_hash,execution_token,deadline)
  VALUES(slot.tenant_id,slot.owner_id,slot.profile_hash,p_execution_token,slot.deadline) ON CONFLICT(tenant_id) DO NOTHING;
 claimed:=FOUND;
 RETURN jsonb_build_object('claimed',claimed,'reason',CASE WHEN claimed THEN NULL ELSE 'TRIAL_EXECUTION_ALREADY_CLAIMED' END);
END $$;
REVOKE ALL ON FUNCTION public.oa_trial_claim_execution(text,text) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_trial_claim_execution(text,text) TO oa_runtime;
