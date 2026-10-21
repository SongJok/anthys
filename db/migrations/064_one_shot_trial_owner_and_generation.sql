-- Bound message/task/run metadata belongs only to the specified employee.
ALTER POLICY trial_namespace ON public.one_shot_trials USING
 (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE OR REPLACE FUNCTION public.oa_trial_check(p_run uuid DEFAULT NULL,p_recovery boolean DEFAULT false,p_close text DEFAULT NULL)
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
 ELSIF EXISTS(SELECT 1 FROM public.runs r WHERE r.tenant_id=slot.tenant_id AND r.id=slot.run_id AND (r.retry_generation<>0 OR r.source_reply_id IS NOT NULL OR r.group_reply_id IS NOT NULL))
  THEN reason:='TRIAL_CONTINUATION_DISABLED';
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
