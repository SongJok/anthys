-- A fresh proof exists before insertTask's pre-insert guard. Permit that
-- incomplete view only in its real creating transaction; the schema71 deferred
-- constraint still requires complete task/run/inbox consistency at COMMIT.
-- Existing proofs retain NULL; never fabricate their historical transaction ID.
ALTER TABLE public.one_shot_trial_admissions ADD COLUMN admitted_txid bigint;
ALTER TABLE public.one_shot_trial_admissions ALTER COLUMN admitted_txid SET DEFAULT txid_current();
ALTER TABLE public.one_shot_trial_admissions ADD CONSTRAINT trial_admission_txid_positive CHECK(admitted_txid IS NULL OR admitted_txid>0);

CREATE OR REPLACE FUNCTION public.oa_trial_check(p_run uuid DEFAULT NULL,p_recovery boolean DEFAULT false,p_close text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE formal jsonb;receipt public.formal_admissions;slot public.one_shot_trials;checked jsonb;
BEGIN
 formal:=public.oa_formal_state();
 IF formal IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
   THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'reason','FORMAL_PROFILE_REQUIRED');END IF;
  checked:=public.oa_trial_check_schema68(p_run,p_recovery,p_close);
  IF coalesce((checked->>'restricted')::boolean,false) AND coalesce((checked->>'allowed')::boolean,false) AND checked->>'state'='BOUND' THEN
   SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR UPDATE;
   IF NOT EXISTS(SELECT 1 FROM public.one_shot_trial_admissions a WHERE a.tenant_id=slot.tenant_id AND a.owner_id=slot.owner_id
    AND a.profile_hash=slot.profile_hash AND a.msg_id=slot.msg_id AND a.task_id=slot.task_id AND a.run_id=slot.run_id
    AND a.admission_cutoff_ms=ceil(extract(epoch FROM slot.created_at)*1000)::bigint
    AND a.event_created_ms>=a.admission_cutoff_ms AND a.event_created_ms<floor(extract(epoch FROM slot.deadline)*1000)::bigint) OR (NOT public.oa_trial_admission_binding_valid(slot.tenant_id) AND NOT EXISTS(SELECT 1 FROM public.one_shot_trial_admissions a WHERE a.tenant_id=slot.tenant_id AND a.admitted_txid=txid_current()))
   THEN
    PERFORM public.oa_trial_close(slot.tenant_id,'TRIAL_EVENT_PROOF_REQUIRED');
    RETURN checked||jsonb_build_object('allowed',false,'reason','TRIAL_EVENT_PROOF_REQUIRED','state','CLOSED');
   END IF;
  END IF;
  RETURN checked;
 END IF;
 IF NOT (formal->>'allowed')::boolean THEN RETURN formal;END IF;
 IF p_run IS NULL THEN RETURN formal;END IF;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF p_run=slot.run_id THEN RETURN formal||jsonb_build_object('allowed',false,'reason','CLOSED_TRIAL_RUN_NEVER_RESUMES');END IF;
 SELECT * INTO receipt FROM public.formal_admissions WHERE tenant_id=slot.tenant_id AND owner_id=slot.owner_id AND authorization_id=(formal->>'authorizationId')::uuid AND candidate_run_id=p_run;
 IF NOT FOUND OR receipt.run_id IS NULL AND receipt.admitted_txid<>txid_current() THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_RUN_NOT_ADMITTED');END IF;
 RETURN formal||jsonb_build_object('taskId',receipt.candidate_task_id,'runId',receipt.candidate_run_id,'msgId',receipt.msg_id);
END $$;
REVOKE ALL ON FUNCTION public.oa_trial_check(uuid,boolean,text) FROM PUBLIC,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_trial_check(uuid,boolean,text) TO oa_app,oa_runtime;


