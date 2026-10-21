CREATE FUNCTION public.oa_trial_close(p_tenant uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE slot public.one_shot_trials;
BEGIN
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR slot.state='CLOSED' THEN RETURN; END IF;
 UPDATE public.one_shot_trials SET state='CLOSED',closed_at=clock_timestamp(),close_reason=left(p_reason,128) WHERE tenant_id=p_tenant;
 UPDATE public.tasks SET cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),
  status=CASE WHEN status='COMPLETED' THEN status ELSE 'CANCELLED' END,version=version+1
  WHERE tenant_id=p_tenant AND id=slot.task_id;
 UPDATE public.runs SET status=CASE WHEN status IN ('SUCCEEDED','FAILED','EXPIRED') THEN status ELSE 'CANCELLED' END,
  lease_until=NULL,lease_owner=NULL,last_error=left(p_reason,128),version=version+1
  WHERE tenant_id=p_tenant AND task_id=slot.task_id;
 -- An in-flight physical write cannot be recalled. Never make it retryable.
 UPDATE public.deliveries SET state=CASE WHEN state='SENDING' THEN 'UNKNOWN' ELSE 'SUPPRESSED' END,
  last_error=left(p_reason,128),version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant AND task_id=slot.task_id AND state IN ('PENDING','SENDING');
 -- Quota recovery/settlement owns the ledger; no money is reset here.
END $$;

CREATE FUNCTION public.oa_trial_check(p_run uuid DEFAULT NULL,p_recovery boolean DEFAULT false,p_close text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE slot public.one_shot_trials; reason text; attestation text;
BEGIN
 attestation:=nullif(current_setting('app.trial_profile_hash',true),'');
 SELECT * INTO slot FROM public.one_shot_trials
  WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('restricted',attestation IS NOT NULL,'allowed',attestation IS NULL,'reason','TRIAL_RECORD_MISSING'); END IF;
 -- A different employee cannot consume, close, or observe this slot's binding.
 IF slot.owner_id IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')::uuid
 THEN RETURN jsonb_build_object('restricted',true,'allowed',false,'reason','TRIAL_SUBJECT_MISMATCH'); END IF;
 IF slot.state='CLOSED' THEN reason:='TRIAL_CLOSED';
 ELSIF slot.profile_hash IS DISTINCT FROM attestation THEN reason:='TRIAL_PROFILE_MISMATCH';
 ELSIF slot.deadline<=clock_timestamp() THEN reason:='TRIAL_DEADLINE';
 ELSIF p_close IS NOT NULL THEN reason:=p_close;
 ELSIF EXISTS(SELECT 1 FROM public.quota_ledger q WHERE q.tenant_id=slot.tenant_id AND q.run_id=slot.run_id
   AND (q.dispatch_state='UNKNOWN' OR q.cost_state='UNKNOWN' OR q.token_state='UNKNOWN'
     OR p_recovery AND q.dispatch_state='DISPATCHING' AND NOT EXISTS
       (SELECT 1 FROM public.runs r WHERE r.tenant_id=q.tenant_id AND r.id=q.run_id AND r.status='RUNNING' AND r.fence=q.run_fence AND r.lease_until>clock_timestamp())))
  THEN reason:='TRIAL_MODEL_UNKNOWN';
 ELSIF EXISTS(SELECT 1 FROM public.deliveries d WHERE d.tenant_id=slot.tenant_id AND d.task_id=slot.task_id
   AND (d.state='UNKNOWN' OR p_recovery AND d.state='SENDING' AND d.sending_at<clock_timestamp()-interval '60 seconds'))
  THEN reason:='TRIAL_DELIVERY_UNKNOWN';
 ELSIF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id
   WHERE u.tenant_id=slot.tenant_id AND u.id=slot.owner_id AND u.external_user_id=slot.external_user_id AND u.status='ACTIVE' AND t.status='ACTIVE' AND t.corp_id=slot.corp_id)
  THEN reason:='TRIAL_IDENTITY_CHANGED';
 END IF;
 IF reason IS NOT NULL AND reason<>'TRIAL_CLOSED' THEN
  PERFORM public.oa_trial_close(slot.tenant_id,reason);slot.state:='CLOSED';
 END IF;
 IF reason IS NULL AND p_run IS NOT NULL AND (slot.state<>'BOUND' OR slot.run_id IS DISTINCT FROM p_run)
 THEN reason:='TRIAL_RUN_MISMATCH'; END IF;
 RETURN jsonb_build_object('restricted',true,'allowed',reason IS NULL,'reason',reason,'state',slot.state,
  'taskId',slot.task_id,'runId',slot.run_id,'msgId',slot.msg_id,'deadline',slot.deadline);
END $$;

CREATE FUNCTION public.oa_trial_admit(p_corp text,p_employee text,p_robot text,p_conversation text,p_msg text,p_eligible boolean,p_task uuid,p_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE slot public.one_shot_trials; checked jsonb;
BEGIN
 checked:=public.oa_trial_check();IF NOT (checked->>'restricted')::boolean THEN RETURN checked; END IF;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR UPDATE;
 IF NOT FOUND OR slot.owner_id IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')::uuid
  OR (slot.corp_id,slot.external_user_id,slot.robot_code,slot.conversation_id) IS DISTINCT FROM (p_corp,p_employee,p_robot,p_conversation) OR NOT p_eligible
 THEN RETURN jsonb_build_object('restricted',true,'allowed',false,'reason','TRIAL_MESSAGE_REJECTED'); END IF;
 -- A replay acknowledges the existing task even after closure; it never resumes it.
 IF slot.msg_id=p_msg THEN RETURN checked||jsonb_build_object('duplicate',true,'taskId',slot.task_id); END IF;
 IF NOT (checked->>'allowed')::boolean OR slot.state<>'ARMED'
 THEN RETURN checked||jsonb_build_object('allowed',false,'reason',coalesce(checked->>'reason','TRIAL_ALREADY_BOUND')); END IF;
 UPDATE public.one_shot_trials SET state='BOUND',msg_id=p_msg,task_id=p_task,run_id=p_run,bound_at=clock_timestamp() WHERE tenant_id=slot.tenant_id;
 RETURN checked||jsonb_build_object('allowed',true,'duplicate',false,'taskId',p_task,'runId',p_run);
END $$;

CREATE FUNCTION public.oa_trial_task_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE slot public.one_shot_trials;
BEGIN
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=NEW.tenant_id FOR UPDATE;
 IF FOUND AND (slot.state<>'BOUND' OR NEW.id IS DISTINCT FROM slot.task_id OR NEW.requester_id IS DISTINCT FROM slot.owner_id
  OR slot.deadline<=clock_timestamp() OR slot.profile_hash IS DISTINCT FROM nullif(current_setting('app.trial_profile_hash',true),''))
 THEN RAISE EXCEPTION 'TRIAL_TASK_CREATION_FORBIDDEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trial_task_creation BEFORE INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.oa_trial_task_guard();

-- Startup inspection is contentless and runs before connector initialization.
-- Multiple process restarts while dispatch is in flight close conservatively.
CREATE FUNCTION public.oa_trial_bootstrap(p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE slot public.one_shot_trials; tenant uuid; actor uuid;
BEGIN
 tenant:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
 -- No profile: only a contentless existence veto, never a cross-tenant close.
 IF tenant IS NULL OR actor IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.one_shot_trials) OR p_hash IS NOT NULL THEN RETURN jsonb_build_object('blocked',true); END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=tenant FOR UPDATE;
 IF NOT FOUND OR slot.owner_id<>actor THEN RETURN jsonb_build_object('blocked',true); END IF;
 IF slot.state='CLOSED' THEN RETURN jsonb_build_object('blocked',true); END IF;
 IF slot.profile_hash IS DISTINCT FROM p_hash OR p_hash IS DISTINCT FROM nullif(current_setting('app.trial_profile_hash',true),'') THEN
  PERFORM public.oa_trial_close(tenant,'TRIAL_PROFILE_MISMATCH');RETURN jsonb_build_object('blocked',true);
 END IF;
 IF slot.deadline<=clock_timestamp() THEN
  PERFORM public.oa_trial_close(tenant,'TRIAL_DEADLINE');RETURN jsonb_build_object('blocked',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.quota_ledger q WHERE q.tenant_id=tenant AND q.run_id=slot.run_id AND
    (q.dispatch_state='UNKNOWN' OR q.cost_state='UNKNOWN' OR q.token_state='UNKNOWN' OR q.dispatch_state='DISPATCHING' AND NOT EXISTS
     (SELECT 1 FROM public.runs r WHERE r.tenant_id=q.tenant_id AND r.id=q.run_id AND r.status='RUNNING' AND r.fence=q.run_fence AND r.lease_until>clock_timestamp())))
   OR EXISTS(SELECT 1 FROM public.deliveries d WHERE d.tenant_id=tenant AND d.task_id=slot.task_id AND (d.state='UNKNOWN' OR d.state='SENDING' AND d.sending_at<clock_timestamp()-interval '60 seconds')) THEN
  PERFORM public.oa_trial_close(tenant,'TRIAL_ORPHAN_AT_STARTUP');RETURN jsonb_build_object('blocked',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.quota_ledger q WHERE q.tenant_id=tenant AND q.run_id=slot.run_id AND q.dispatch_state='DISPATCHING')
   OR EXISTS(SELECT 1 FROM public.deliveries d WHERE d.tenant_id=tenant AND d.task_id=slot.task_id AND d.state='SENDING') THEN
  -- Fresh leases are not proof of abandonment. Refuse the additional process.
  RETURN jsonb_build_object('blocked',true);
 END IF;
 RETURN jsonb_build_object('tenantId',tenant,'actorId',actor,'corpId',slot.corp_id,'robotCode',slot.robot_code,'budgetPolicyHash',slot.budget_policy_hash);
END $$;
CREATE FUNCTION public.oa_trial_present() RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM public.one_shot_trials) $$;
REVOKE ALL ON FUNCTION public.oa_trial_present() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_trial_present() TO oa_app,oa_runtime;

REVOKE ALL ON FUNCTION public.oa_trial_close(uuid,text),public.oa_trial_check(uuid,boolean,text),public.oa_trial_admit(text,text,text,text,text,boolean,uuid,uuid),public.oa_trial_task_guard(),public.oa_trial_bootstrap(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_trial_check(uuid,boolean,text),public.oa_trial_admit(text,text,text,text,text,boolean,uuid,uuid),public.oa_trial_bootstrap(text) TO oa_runtime;
ALTER TABLE public.one_shot_trials ADD CONSTRAINT trial_armed_unbound CHECK(state<>'ARMED' OR task_id IS NULL);
ALTER TABLE public.one_shot_trials ADD CONSTRAINT trial_task_fk FOREIGN KEY(tenant_id,task_id) REFERENCES public.tasks(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.one_shot_trials ADD CONSTRAINT trial_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES public.runs(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
