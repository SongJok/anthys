-- App task creation uses the same owner/tenant-bound gate. This function
-- cannot observe or close a different employee's trial.
GRANT EXECUTE ON FUNCTION public.oa_trial_check(uuid,boolean,text) TO oa_app;
CREATE OR REPLACE FUNCTION public.oa_trial_bootstrap(p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
 IF NOT FOUND THEN IF p_hash IS NULL THEN RETURN NULL; ELSE RETURN jsonb_build_object('blocked',true); END IF; END IF;
 IF slot.owner_id<>actor THEN RETURN jsonb_build_object('blocked',true); END IF;
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
CREATE OR REPLACE FUNCTION public.oa_trial_present() RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.one_shot_trials WHERE
 nullif(current_setting('app.tenant_id',true),'') IS NULL OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
$$;
