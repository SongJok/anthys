-- New evidence lives outside the CLOSED trial tombstone. Do not rewrite the
-- original trial JSON snapshot or invent a provider timestamp for legacy runs.
CREATE TABLE public.one_shot_trial_admissions (
 tenant_id uuid PRIMARY KEY REFERENCES public.one_shot_trials(tenant_id),
 owner_id uuid NOT NULL,
 profile_hash text NOT NULL CHECK(length(profile_hash)=64),
 msg_id text NOT NULL CHECK(length(msg_id) BETWEEN 1 AND 1024),
 task_id uuid NOT NULL,run_id uuid NOT NULL,
 event_created_ms bigint NOT NULL CHECK(event_created_ms>0),
 admission_cutoff_ms bigint NOT NULL CHECK(admission_cutoff_ms>0),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(event_created_ms>=admission_cutoff_ms),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES public.tasks(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,run_id) REFERENCES public.runs(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.one_shot_trial_admissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY trial_admission_owner ON public.one_shot_trial_admissions USING
 (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
REVOKE ALL ON public.one_shot_trial_admissions FROM PUBLIC,oa_app,oa_runtime,oa_queue;
GRANT SELECT ON public.one_shot_trial_admissions TO oa_runtime;
CREATE FUNCTION public.oa_trial_admission_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'TRIAL_ADMISSION_IMMUTABLE';END $$;
CREATE TRIGGER trial_admission_immutable BEFORE UPDATE OR DELETE ON public.one_shot_trial_admissions
FOR EACH ROW EXECUTE FUNCTION public.oa_trial_admission_immutable();
REVOKE ALL ON FUNCTION public.oa_trial_admission_immutable() FROM PUBLIC,oa_app,oa_runtime,oa_queue;

-- Keep schema69 FORMAL semantics unchanged; only TRIAL BOUND requires the new
-- exact admission witness. ARMED and already CLOSED rows are not backfilled.
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
    AND a.event_created_ms>=a.admission_cutoff_ms AND a.event_created_ms<floor(extract(epoch FROM slot.deadline)*1000)::bigint)
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

-- No public or application-role route may bind a new trial without creation
-- time. These SECURITY DEFINER helpers are callable by their owner internally.
REVOKE ALL ON FUNCTION public.oa_trial_admit(text,text,text,text,text,boolean,uuid,uuid),public.oa_trial_check_schema68(uuid,boolean,text),public.oa_trial_close(uuid,text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_trial_admit_fresh(p_corp text,p_employee text,p_robot text,p_conversation text,p_msg text,p_eligible boolean,p_task uuid,p_run uuid,p_created_ms bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE slot public.one_shot_trials;checked jsonb;admitted jsonb;cutoff bigint;stamp bigint;
BEGIN
 checked:=public.oa_trial_check();
 IF NOT coalesce((checked->>'restricted')::boolean,true) THEN RETURN checked;END IF;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR UPDATE;
 IF NOT FOUND OR slot.owner_id IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')::uuid
  OR (slot.corp_id,slot.external_user_id,slot.robot_code,slot.conversation_id) IS DISTINCT FROM(p_corp,p_employee,p_robot,p_conversation)
  OR p_eligible IS DISTINCT FROM true
 THEN RETURN jsonb_build_object('restricted',true,'allowed',false,'reason','TRIAL_MESSAGE_REJECTED');END IF;
 -- Known replays remain ACK-only, including after closure. No new proof/run.
 IF slot.msg_id=p_msg THEN RETURN public.oa_trial_admit(p_corp,p_employee,p_robot,p_conversation,p_msg,p_eligible,p_task,p_run);END IF;
 IF NOT coalesce((checked->>'allowed')::boolean,false) OR slot.state<>'ARMED'
 THEN RETURN checked||jsonb_build_object('allowed',false,'reason',coalesce(checked->>'reason','TRIAL_ALREADY_BOUND'));END IF;
 cutoff:=ceil(extract(epoch FROM slot.created_at)*1000)::bigint;
 stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF p_created_ms IS NULL OR p_created_ms<=0 OR p_created_ms>9007199254740991
 THEN RETURN checked||jsonb_build_object('allowed',false,'reason','TRIAL_EVENT_TIMESTAMP_REQUIRED');END IF;
 IF p_created_ms<cutoff THEN RETURN checked||jsonb_build_object('allowed',false,'reason','PRE_TRIAL_EVENT_REJECTED');END IF;
 IF p_created_ms>stamp+5000 OR p_created_ms>=floor(extract(epoch FROM slot.deadline)*1000)::bigint
 THEN RETURN checked||jsonb_build_object('allowed',false,'reason','TRIAL_EVENT_TIMESTAMP_FUTURE');END IF;
 IF p_msg IS NULL OR length(p_msg) NOT BETWEEN 1 AND 1024 OR p_task IS NULL OR p_run IS NULL
 THEN RETURN checked||jsonb_build_object('allowed',false,'reason','TRIAL_FRESH_BINDING_REQUIRED');END IF;
 -- The original authority rechecks clock_timestamp() after all lock waits.
 admitted:=public.oa_trial_admit(p_corp,p_employee,p_robot,p_conversation,p_msg,p_eligible,p_task,p_run);
 IF coalesce((admitted->>'allowed')::boolean,false) AND NOT coalesce((admitted->>'duplicate')::boolean,false) THEN
  INSERT INTO public.one_shot_trial_admissions(tenant_id,owner_id,profile_hash,msg_id,task_id,run_id,event_created_ms,admission_cutoff_ms)
   VALUES(slot.tenant_id,slot.owner_id,slot.profile_hash,p_msg,p_task,p_run,p_created_ms,cutoff);
 END IF;
 RETURN admitted;
END $$;
REVOKE ALL ON FUNCTION public.oa_trial_admit_fresh(text,text,text,text,text,boolean,uuid,uuid,bigint) FROM PUBLIC,oa_app,oa_runtime,oa_queue;

-- Original schema69 FORMAL branch preserved verbatim; only TRIAL forwards time.
CREATE OR REPLACE FUNCTION public.oa_lifecycle_admit(p_corp text,p_employee text,p_robot text,p_conversation text,p_msg text,p_trial_eligible boolean,p_task uuid,p_run uuid,p_created_ms bigint,p_channel text,p_attachments boolean,p_control boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE formal jsonb;slot public.one_shot_trials;receipt public.formal_admissions;existing_task uuid;tenant uuid;actor uuid;
BEGIN
 formal:=public.oa_formal_state('INGRESS');IF formal IS NULL THEN RETURN public.oa_trial_admit_fresh(p_corp,p_employee,p_robot,p_conversation,p_msg,p_trial_eligible,p_task,p_run,p_created_ms);END IF;
 tenant:=nullif(current_setting('app.tenant_id',true),'')::uuid;actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=tenant FOR UPDATE;
 IF NOT FOUND OR slot.owner_id IS DISTINCT FROM actor OR (slot.corp_id,slot.external_user_id,slot.robot_code,slot.conversation_id) IS DISTINCT FROM(p_corp,p_employee,p_robot,p_conversation) OR p_channel IS DISTINCT FROM 'DM' THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'reason','FORMAL_MESSAGE_BINDING_MISMATCH');END IF;
 -- Known replays can be ACKed even after expiry/revocation. They never mint a
 -- new admission or make the old task/run executable under formal authority.
 IF slot.msg_id=p_msg THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'duplicate',true,'taskId',slot.task_id,'reason','CLOSED_TRIAL_MESSAGE_ACK_ONLY');END IF;
 SELECT * INTO receipt FROM public.formal_admissions WHERE tenant_id=tenant AND owner_id=actor AND msg_id=p_msg;
 IF FOUND THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'duplicate',true,'taskId',receipt.task_id,'reason','FORMAL_MESSAGE_ACK_ONLY');END IF;
 IF EXISTS(SELECT 1 FROM public.event_inbox e WHERE e.tenant_id=tenant AND e.owner_id=actor AND e.source='DINGTALK' AND e.event_key=p_robot||':'||p_conversation||':'||p_msg) THEN
  SELECT t.id INTO existing_task FROM public.tasks t JOIN public.event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id WHERE t.tenant_id=tenant AND t.requester_id=actor AND e.source='DINGTALK' AND e.event_key=p_robot||':'||p_conversation||':'||p_msg;
  RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'duplicate',true,'taskId',existing_task,'reason','OLD_INBOX_ACK_ONLY');
 END IF;
 IF NOT (formal->>'allowed')::boolean THEN RETURN formal;END IF;
 IF p_created_ms IS NULL OR p_created_ms<=0 THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_EVENT_TIMESTAMP_REQUIRED');END IF;
 IF p_created_ms<(formal->>'admissionCutoffMs')::bigint THEN RETURN formal||jsonb_build_object('allowed',false,'reason','PRE_FORMAL_EVENT_REJECTED');END IF;
 IF p_created_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint+5000 THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_EVENT_TIMESTAMP_FUTURE');END IF;
 IF p_attachments IS NULL OR p_control IS NULL OR p_attachments AND NOT (formal->'inputPolicy'->>'attachments')::boolean OR p_control AND NOT (formal->'inputPolicy'->>'controls')::boolean THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_INPUT_NOT_APPROVED');END IF;
 IF p_msg IS NULL OR length(p_msg) NOT BETWEEN 1 AND 1024 OR p_task IS NULL OR p_run IS NULL OR p_task=slot.task_id OR p_run=slot.run_id OR EXISTS(SELECT 1 FROM public.tasks WHERE tenant_id=tenant AND id=p_task) OR EXISTS(SELECT 1 FROM public.runs WHERE tenant_id=tenant AND id=p_run) THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_FRESH_BINDING_REQUIRED');END IF;
 INSERT INTO public.formal_admissions(tenant_id,owner_id,authorization_id,msg_id,conversation_id,event_created_ms,candidate_task_id,candidate_run_id) VALUES(tenant,actor,(formal->>'authorizationId')::uuid,p_msg,p_conversation,p_created_ms,p_task,p_run);
 RETURN formal||jsonb_build_object('allowed',true,'duplicate',false,'taskId',p_task,'runId',p_run,'msgId',p_msg);
END $$;
REVOKE ALL ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) TO oa_runtime;
