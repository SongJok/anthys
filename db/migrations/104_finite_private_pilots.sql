-- Opt-in finite private enterprise pilot. This migration installs no approval,
-- grant, budget or service. CLOSED remains the immutable source tombstone.
CREATE TABLE public.finite_private_pilots(
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,pilot_key text NOT NULL,
 profile_hash text NOT NULL,document jsonb NOT NULL,authorization_id uuid NOT NULL,
 source_trial_hash text NOT NULL,question_hash text NOT NULL,valid_from timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 max_model_requests int NOT NULL CHECK(max_model_requests BETWEEN 1 AND 4),model_requests int NOT NULL DEFAULT 0,
 enterprise_requests int NOT NULL DEFAULT 0 CHECK(enterprise_requests BETWEEN 0 AND 1),physical_messages int NOT NULL DEFAULT 0 CHECK(physical_messages BETWEEN 0 AND 1),
 task_id uuid,run_id uuid,admission_msg_id text,stopped_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,pilot_key),UNIQUE(tenant_id,owner_id),UNIQUE(tenant_id,authorization_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,authorization_id) REFERENCES public.formal_authorizations(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES public.tasks(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,run_id) REFERENCES public.runs(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(model_requests BETWEEN 0 AND max_model_requests),CHECK(expires_at>valid_from AND expires_at<=valid_from+interval '30 minutes'),
 CHECK((task_id IS NULL)=(run_id IS NULL) AND (run_id IS NULL)=(admission_msg_id IS NULL)),
 CHECK(profile_hash~'^[a-f0-9]{64}$' AND pilot_key~'^[a-f0-9]{64}$' AND source_trial_hash~'^[a-f0-9]{64}$' AND question_hash~'^[a-f0-9]{64}$')
);
ALTER TABLE public.finite_private_pilots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finite_private_pilots FORCE ROW LEVEL SECURITY;
CREATE POLICY pilot_owner ON public.finite_private_pilots USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON public.finite_private_pilots TO oa_runtime;
CREATE TABLE public.finite_private_pilot_dispatches(
 tenant_id uuid NOT NULL,pilot_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('MODEL','ENTERPRISE','MESSAGE')),
 dispatch_id uuid NOT NULL,payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,pilot_id,kind,dispatch_id),FOREIGN KEY(tenant_id,pilot_id) REFERENCES public.finite_private_pilots(tenant_id,id)
);
ALTER TABLE public.finite_private_pilot_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finite_private_pilot_dispatches FORCE ROW LEVEL SECURITY;
-- No runtime writes, refunds, deletes or replacement documents. Install is a
-- separate reviewed operator transaction, not a mutation authorized by this DDL.
CREATE FUNCTION public.oa_finite_private_pilot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='finite_private_pilot_dispatches' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'FINITE_PILOT_TOMBSTONE_IMMUTABLE';END IF;
 IF (to_jsonb(NEW)-ARRAY['task_id','run_id','admission_msg_id','model_requests','enterprise_requests','physical_messages','stopped_at']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['task_id','run_id','admission_msg_id','model_requests','enterprise_requests','physical_messages','stopped_at'])
 OR OLD.task_id IS NOT NULL AND (NEW.task_id,NEW.run_id,NEW.admission_msg_id) IS DISTINCT FROM(OLD.task_id,OLD.run_id,OLD.admission_msg_id)
 OR OLD.stopped_at IS NOT NULL AND NEW.stopped_at IS DISTINCT FROM OLD.stopped_at
 OR NEW.model_requests<OLD.model_requests OR NEW.enterprise_requests<OLD.enterprise_requests OR NEW.physical_messages<OLD.physical_messages
 THEN RAISE EXCEPTION 'FINITE_PILOT_TOMBSTONE_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER finite_pilot_immutable BEFORE UPDATE OR DELETE ON public.finite_private_pilots FOR EACH ROW EXECUTE FUNCTION public.oa_finite_private_pilot_immutable();
CREATE TRIGGER finite_pilot_dispatch_immutable BEFORE UPDATE OR DELETE ON public.finite_private_pilot_dispatches FOR EACH ROW EXECUTE FUNCTION public.oa_finite_private_pilot_immutable();

CREATE FUNCTION public.oa_finite_private_pilot_register(p_document text,p_hash text,p_key text,p_review text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE d jsonb;p public.finite_private_pilots;a public.formal_authorizations;s public.one_shot_trials;t uuid;o uuid;key_hash text;first_at timestamptz;last_at timestamptz;
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'FINITE_PILOT_MIGRATOR_REQUIRED';END IF;
 IF p_document IS NULL OR octet_length(p_document)>32768 OR p_hash IS DISTINCT FROM encode(sha256(convert_to(p_document,'UTF8')),'hex') THEN RAISE EXCEPTION 'FINITE_PILOT_PROFILE_INVALID';END IF;
 d:=p_document::jsonb;
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR d->>'purpose' IS DISTINCT FROM 'FINITE_PRIVATE_ENTERPRISE_PILOT' OR d->'approved' IS DISTINCT FROM 'true'::jsonb OR d->'finalOnly' IS DISTINCT FROM 'true'::jsonb
 OR d->'maxEnterpriseRequests' IS DISTINCT FROM '1'::jsonb OR d->'maxPhysicalMessages' IS DISTINCT FROM '1'::jsonb OR d->>'modelCurrency' IS DISTINCT FROM 'CNY'
 OR d->>'reviewReference' IS DISTINCT FROM p_review OR coalesce(p_review,'')!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$' OR length(p_review)>512
 THEN RAISE EXCEPTION 'FINITE_PILOT_PROFILE_INVALID';END IF;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(d) k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(ARRAY['schemaVersion','purpose','approved','id','tenantId','actorId','sourceTrialProfileHash','formalAuthorizationId','formalProfileHash','corpId','externalUserId','robotCode','conversationId','questionHash','companyPolicyHash','enterpriseBudgetHash','enterpriseUpstreamHash','budgetPolicyHash','enterpriseResourceId','validFrom','expiresAt','maxModelRequests','maxEnterpriseRequests','maxPhysicalMessages','finalOnly','enterpriseWaitMs','modelCurrency','modelMaxAmountMinor','reviewReference','modelApprovalReference','sourceReviewHash','enterpriseApprovalReference','enterpriseCost']) k) THEN RAISE EXCEPTION 'FINITE_PILOT_PROFILE_KEYS_INVALID';END IF;
 IF d->'enterpriseCost'->>'kind' IS DISTINCT FROM 'FIXED_INTERNAL' OR d->'enterpriseCost'->>'currency' IS DISTINCT FROM 'CNY' OR d->'enterpriseCost'->'maxAmountMinor' IS DISTINCT FROM '0'::jsonb OR coalesce(d->'enterpriseCost'->>'upstreamReviewHash','')!~'^[a-f0-9]{64}$' OR coalesce(d->'enterpriseCost'->>'reviewReference','')!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$' THEN RAISE EXCEPTION 'FINITE_PILOT_COMPANY_COVERED_COST_DECLARATION_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['maxModelRequests','maxEnterpriseRequests','maxPhysicalMessages','enterpriseWaitMs','modelMaxAmountMinor']) k WHERE jsonb_typeof(d->k) IS DISTINCT FROM 'number' OR coalesce(d->>k,'')!~'^[0-9]+$')
 OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(d->'enterpriseCost') k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(ARRAY['kind','currency','maxAmountMinor','reviewReference','upstreamReviewHash']) k)
 OR coalesce(d->>'enterpriseResourceId','')!~'^enterprise-agent:[a-fA-F0-9-]{36}$'
 THEN RAISE EXCEPTION 'FINITE_PILOT_PROFILE_INVALID';END IF;
 t:=(d->>'tenantId')::uuid;o:=(d->>'actorId')::uuid;first_at:=(d->>'validFrom')::timestamptz;last_at:=(d->>'expiresAt')::timestamptz;
 key_hash:=encode(sha256(convert_to('FINITE_PRIVATE_ENTERPRISE_PILOT_V1:'||t::text||':'||o::text||':'||(d->>'sourceTrialProfileHash')||':'||(d->>'questionHash'),'UTF8')),'hex');
 IF key_hash IS DISTINCT FROM p_key OR NOT isfinite(first_at) OR NOT isfinite(last_at) OR last_at<=clock_timestamp() OR last_at<=first_at OR last_at>first_at+interval '30 minutes'
 OR (d->>'maxModelRequests')::int NOT BETWEEN 1 AND 4 OR (d->>'modelMaxAmountMinor')::int NOT BETWEEN 1 AND 100 OR (d->>'enterpriseWaitMs')::int NOT BETWEEN 1 AND 1200000
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['sourceTrialProfileHash','formalProfileHash','questionHash','companyPolicyHash','enterpriseBudgetHash','enterpriseUpstreamHash','budgetPolicyHash','sourceReviewHash']) k WHERE coalesce(d->>k,'')!~'^[a-f0-9]{64}$')
 THEN RAISE EXCEPTION 'FINITE_PILOT_PROFILE_INVALID';END IF;
 SELECT * INTO s FROM public.one_shot_trials WHERE tenant_id=t FOR UPDATE;
 SELECT * INTO a FROM public.formal_authorizations WHERE tenant_id=t AND id=(d->>'formalAuthorizationId')::uuid AND owner_id=o FOR UPDATE;
 IF s.state IS DISTINCT FROM 'CLOSED' OR s.owner_id IS DISTINCT FROM o OR s.profile_hash IS DISTINCT FROM d->>'sourceTrialProfileHash' OR a.id IS NULL OR a.state<>'AUTHORIZED'
 OR a.profile_hash IS DISTINCT FROM d->>'formalProfileHash' OR a.source_trial_profile_hash IS DISTINCT FROM s.profile_hash OR a.profile_document->'schemaVersion' IS DISTINCT FROM '1'::jsonb
 OR (s.corp_id,s.external_user_id,s.robot_code,s.conversation_id) IS DISTINCT FROM(d->>'corpId',d->>'externalUserId',d->>'robotCode',d->>'conversationId')
 OR NOT a.model_allowed OR a.model_approval_reference IS DISTINCT FROM d->>'modelApprovalReference' OR a.budget_policy_hash IS DISTINCT FROM d->>'budgetPolicyHash'
 OR first_at<a.valid_from OR last_at>a.valid_until OR a.profile_document->'inputPolicy' IS DISTINCT FROM '{"attachments":false,"controls":false}'::jsonb
 OR jsonb_array_length(a.profile_document->'capabilities')<>1 OR a.profile_document->'capabilities'->0->>'id' IS DISTINCT FROM 'company.agent.ask'
 OR a.source_trial_snapshot_hash IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'FINITE_PILOT_CLOSED_FORMAL_BINDING_REQUIRED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.budget_policies b WHERE b.tenant_id=t AND b.policy_hash=d->>'budgetPolicyHash' AND b.currency='CNY' AND b.blocked_reason IS NULL AND b.valid_until>=last_at AND (b.document->'limits'->'task'->>'money')::numeric<=((d->>'modelMaxAmountMinor')::numeric/100))
 THEN RAISE EXCEPTION 'FINITE_PILOT_MODEL_MONEY_CAP_REQUIRED';END IF;
 -- This entry never repairs or creates a grant. A missing narrowly reviewed
 -- enterprise grant is an explicit remaining prerequisite, not implicit consent.
 IF NOT EXISTS(SELECT 1 FROM public.resource_grants g WHERE g.tenant_id=t AND g.actor_id=o AND g.capability_id='company.agent.ask' AND g.resource_id=d->>'enterpriseResourceId' AND g.audience_kind='PRIVATE_USER' AND g.audience_id=o::text AND g.revoked_at IS NULL AND g.expires_at>=last_at)
 THEN RAISE EXCEPTION 'FINITE_PILOT_ENTERPRISE_GRANT_REQUIRED';END IF;
 SELECT * INTO p FROM public.finite_private_pilots WHERE tenant_id=t AND (owner_id=o OR pilot_key=p_key) FOR UPDATE;
 IF FOUND THEN IF p.profile_hash=p_hash AND p.pilot_key=p_key THEN RETURN jsonb_build_object('id',p.id,'replayed',true);END IF;RAISE EXCEPTION 'FINITE_PILOT_REPLACEMENT_FORBIDDEN';END IF;
 IF EXISTS(SELECT 1 FROM public.formal_admissions WHERE tenant_id=t AND owner_id=o AND authorization_id=a.id) THEN RAISE EXCEPTION 'FINITE_PILOT_MUST_PRECEDE_ADMISSION';END IF;
 INSERT INTO public.finite_private_pilots(tenant_id,id,owner_id,pilot_key,profile_hash,document,authorization_id,source_trial_hash,question_hash,valid_from,expires_at,max_model_requests)
 VALUES(t,(d->>'id')::uuid,o,p_key,p_hash,d,a.id,s.profile_hash,d->>'questionHash',first_at,last_at,(d->>'maxModelRequests')::int);
 RETURN jsonb_build_object('id',d->>'id','replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_finite_private_pilot_register(text,text,text,text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;

CREATE FUNCTION public.oa_finite_private_pilot_active(p_run uuid DEFAULT NULL,p_task uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.finite_private_pilots p WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND p.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND (p_run IS NULL OR p.run_id=p_run) AND (p_task IS NULL OR p.task_id=p_task));
$$;
REVOKE ALL ON FUNCTION public.oa_finite_private_pilot_active(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_finite_private_pilot_active(uuid,uuid) TO oa_app,oa_runtime;

-- Legacy entry cannot omit the input hash. The private old body remains
-- callable only from the new wrapper; unrelated legacy formal v1 is unchanged.
ALTER FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) RENAME TO oa_lifecycle_admit_v100_private;
REVOKE ALL ON FUNCTION public.oa_lifecycle_admit_v100_private(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_lifecycle_admit(p_corp text,p_employee text,p_robot text,p_conversation text,p_msg text,p_eligible boolean,p_task uuid,p_run uuid,p_created bigint,p_channel text,p_attachments boolean,p_control boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF public.oa_finite_private_pilot_active() THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'reason','FINITE_PILOT_HASH_BOUND_ENTRY_REQUIRED');END IF;
 RETURN public.oa_lifecycle_admit_v100_private(p_corp,p_employee,p_robot,p_conversation,p_msg,p_eligible,p_task,p_run,p_created,p_channel,p_attachments,p_control);
END $$;
REVOKE ALL ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) TO oa_runtime;
ALTER FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean,text,text) RENAME TO oa_lifecycle_admit_v100;
REVOKE ALL ON FUNCTION public.oa_lifecycle_admit_v100(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean,text,text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_lifecycle_admit(p_corp text,p_employee text,p_robot text,p_conversation text,p_msg text,p_eligible boolean,p_task uuid,p_run uuid,p_created bigint,p_channel text,p_attachments boolean,p_control boolean,p_hash text,p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.finite_private_pilots;r jsonb;
BEGIN
 PERFORM public.oa_formal_state('INGRESS');
 SELECT * INTO p FROM public.finite_private_pilots WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN public.oa_lifecycle_admit_v100(p_corp,p_employee,p_robot,p_conversation,p_msg,p_eligible,p_task,p_run,p_created,p_channel,p_attachments,p_control,p_hash,p_kind);END IF;
 IF p.stopped_at IS NOT NULL OR p.stopped_at IS NOT NULL OR p.valid_from>clock_timestamp() OR p.expires_at<=clock_timestamp() OR p.document->>'formalProfileHash' IS DISTINCT FROM nullif(current_setting('app.formal_profile_hash',true),'')
 OR p_hash IS DISTINCT FROM p.question_hash OR p_kind IS DISTINCT FROM 'NONE' OR p_channel IS DISTINCT FROM 'DM' OR p_eligible IS DISTINCT FROM true OR p_attachments IS DISTINCT FROM false OR p_control IS DISTINCT FROM false
 THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'reason','FINITE_PILOT_INPUT_NOT_APPROVED');END IF;
 IF p.task_id IS NOT NULL THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'duplicate',p.admission_msg_id=p_msg,'taskId',CASE WHEN p.admission_msg_id=p_msg THEN p.task_id ELSE NULL END,'reason','FINITE_PILOT_QUESTION_LIMIT');END IF;
 r:=public.oa_lifecycle_admit_v100_private(p_corp,p_employee,p_robot,p_conversation,p_msg,p_eligible,p_task,p_run,p_created,p_channel,p_attachments,p_control);
 IF coalesce((r->>'allowed')::boolean,false) THEN
  UPDATE public.finite_private_pilots SET task_id=p_task,run_id=p_run,admission_msg_id=p_msg WHERE tenant_id=p.tenant_id AND id=p.id;
 END IF;RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean,text,text) TO oa_runtime;

-- Deferred original event/task/run witness, plus per-dispatch durable slots.
CREATE FUNCTION public.oa_finite_private_pilot_admission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.finite_private_pilots;
BEGIN
 SELECT * INTO p FROM public.finite_private_pilots WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id;
 IF NOT FOUND THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.formal_admissions a JOIN public.tasks t ON t.tenant_id=a.tenant_id AND t.id=a.task_id JOIN public.runs r ON r.tenant_id=t.tenant_id AND r.id=a.run_id AND r.task_id=t.id
 JOIN public.conversations v ON v.tenant_id=t.tenant_id AND v.id=t.conversation_id JOIN public.event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id
 WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.id AND a.authorization_id=p.authorization_id AND a.task_id=p.task_id AND a.run_id=p.run_id AND a.msg_id=p.admission_msg_id
 AND t.requester_id=p.owner_id AND r.owner_id=p.owner_id AND t.control_kind IS NULL AND v.kind='DM' AND v.external_id=p.document->>'conversationId'
 AND t.audience=jsonb_build_object('kind','PRIVATE_USER','targetId',p.owner_id::text,'classificationCeiling','RESTRICTED')
 AND encode(sha256(convert_to(t.goal,'UTF8')),'hex')=p.question_hash AND e.source='DINGTALK' AND e.owner_id=p.owner_id AND e.event_key=(p.document->>'robotCode')||':'||(p.document->>'conversationId')||':'||p.admission_msg_id)
 THEN RAISE EXCEPTION 'FINITE_PILOT_ADMISSION_WITNESS_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER finite_pilot_admission_guard AFTER INSERT OR UPDATE ON public.formal_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.oa_finite_private_pilot_admission_guard();

CREATE FUNCTION public.oa_finite_private_pilot_dispatch(p_run uuid,p_kind text,p_dispatch uuid,p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.finite_private_pilots;
BEGIN
 IF public.oa_finite_private_pilot_active() AND NOT public.oa_lifecycle_run_allowed(p_run) THEN RAISE EXCEPTION 'FINITE_PILOT_DISPATCH_DENIED';END IF;
 SELECT * INTO p FROM public.finite_private_pilots WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN true;END IF;
 IF p.run_id IS DISTINCT FROM p_run OR p_dispatch IS NULL OR p_kind NOT IN ('MODEL','ENTERPRISE','MESSAGE') OR coalesce(p_hash,'')!~'^[a-f0-9]{64}$'
 OR p.stopped_at IS NOT NULL OR p.valid_from>clock_timestamp() OR p.expires_at<=clock_timestamp() OR p.document->>'formalProfileHash' IS DISTINCT FROM nullif(current_setting('app.formal_profile_hash',true),'')
 OR EXISTS(SELECT 1 FROM public.tasks WHERE tenant_id=p.tenant_id AND id=p.task_id AND cancel_requested_at IS NOT NULL)
 THEN RAISE EXCEPTION 'FINITE_PILOT_DISPATCH_DENIED';END IF;
 -- Even an exact repeated start is denied: a slot is a once-only witness, not
 -- a reusable HTTP credential. Local failure or lost COMMIT cannot refund it.
 IF EXISTS(SELECT 1 FROM public.finite_private_pilot_dispatches WHERE tenant_id=p.tenant_id AND pilot_id=p.id AND kind=p_kind AND dispatch_id=p_dispatch) THEN RAISE EXCEPTION 'FINITE_PILOT_DISPATCH_ALREADY_STARTED';END IF;
 IF p_kind='MODEL' AND p.model_requests>=p.max_model_requests OR p_kind='ENTERPRISE' AND p.enterprise_requests>=1 OR p_kind='MESSAGE' AND p.physical_messages>=1 THEN RAISE EXCEPTION 'FINITE_PILOT_DISPATCH_LIMIT';END IF;
 INSERT INTO public.finite_private_pilot_dispatches(tenant_id,pilot_id,kind,dispatch_id,payload_hash) VALUES(p.tenant_id,p.id,p_kind,p_dispatch,p_hash);
 UPDATE public.finite_private_pilots SET model_requests=model_requests+CASE WHEN p_kind='MODEL' THEN 1 ELSE 0 END,enterprise_requests=enterprise_requests+CASE WHEN p_kind='ENTERPRISE' THEN 1 ELSE 0 END,physical_messages=physical_messages+CASE WHEN p_kind='MESSAGE' THEN 1 ELSE 0 END WHERE tenant_id=p.tenant_id AND id=p.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.oa_finite_private_pilot_dispatch(uuid,text,uuid,text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;

CREATE FUNCTION public.oa_finite_private_pilot_model_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.dispatch_state='DISPATCHING' AND OLD.dispatch_state IS DISTINCT FROM 'DISPATCHING' AND public.oa_finite_private_pilot_active() THEN
  PERFORM public.oa_finite_private_pilot_dispatch(NEW.run_id,'MODEL',NEW.id,NEW.payload_hash);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER finite_pilot_model_guard BEFORE UPDATE ON public.quota_ledger FOR EACH ROW EXECUTE FUNCTION public.oa_finite_private_pilot_model_guard();
CREATE FUNCTION public.oa_finite_private_pilot_enterprise_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.finite_private_pilots;
BEGIN
 IF NEW.state='DISPATCHING' AND OLD.state IS DISTINCT FROM 'DISPATCHING' THEN
  SELECT * INTO p FROM public.finite_private_pilots WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id;
  IF FOUND THEN
   IF NEW.message_hash IS DISTINCT FROM p.question_hash OR NEW.scope_hash IS DISTINCT FROM p.document->>'companyPolicyHash' OR NEW.upstream_hash IS DISTINCT FROM p.document->>'enterpriseUpstreamHash' OR NEW.budget_hash IS DISTINCT FROM p.document->>'enterpriseBudgetHash' OR NEW.wait_budget_ms>(p.document->>'enterpriseWaitMs')::int OR NEW.deadline>p.expires_at THEN RAISE EXCEPTION 'FINITE_PILOT_ENTERPRISE_CHANGED';END IF;
   PERFORM public.oa_finite_private_pilot_dispatch(NEW.run_id,'ENTERPRISE',NEW.id,NEW.message_hash);
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER finite_pilot_enterprise_guard BEFORE UPDATE ON public.company_agent_requests FOR EACH ROW EXECUTE FUNCTION public.oa_finite_private_pilot_enterprise_guard();

CREATE FUNCTION public.oa_finite_private_pilot_message(p_delivery uuid,p_attempt uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.finite_private_pilots;d public.deliveries;
BEGIN
 SELECT * INTO p FROM public.finite_private_pilots WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid;
 IF NOT FOUND THEN RETURN true;END IF;
 SELECT * INTO d FROM public.deliveries WHERE tenant_id=p.tenant_id AND id=p_delivery AND owner_id=p.owner_id AND task_id=p.task_id AND source_run_id=p.run_id AND state='SENDING' AND attempt_key=p_attempt;
 IF NOT EXISTS(SELECT 1 FROM public.runs r JOIN public.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.tenant_id=p.tenant_id AND r.id=p.run_id AND r.task_id=p.task_id AND r.status IN ('SUCCEEDED','PARTIAL') AND r.clarification_review_id IS NULL AND r.source_choice_id IS NULL AND t.control_kind IS NULL AND t.cancel_requested_at IS NULL)
 OR p.enterprise_requests<>1 OR NOT EXISTS(SELECT 1 FROM public.company_agent_requests q WHERE q.tenant_id=p.tenant_id AND q.run_id=p.run_id AND q.message_hash=p.question_hash AND q.state='RESPONSE_RECEIVED' AND q.response_hash IS NOT NULL AND q.response_ref IS NOT NULL)
 OR d.id IS NULL OR d.finalization_id IS NULL OR d.target IS DISTINCT FROM jsonb_build_object('kind','PRIVATE_USER','targetId',p.owner_id::text,'classificationCeiling','RESTRICTED')
 OR NOT EXISTS(SELECT 1 FROM public.run_finalizations f WHERE f.tenant_id=p.tenant_id AND f.id=d.finalization_id AND f.run_id=p.run_id AND f.owner_id=p.owner_id AND f.state IN ('VERIFIED','PARTIAL') AND f.expires_at>clock_timestamp())
 THEN RETURN false;END IF;
 PERFORM public.oa_finite_private_pilot_dispatch(p.run_id,'MESSAGE',d.id,d.args_hash);RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.oa_finite_private_pilot_message(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_finite_private_pilot_message(uuid,uuid) TO oa_runtime;

-- A stop cancels the original task only. It cannot mint a control task, model
-- request or robot receipt, even before admission or after quota exhaustion.
CREATE FUNCTION public.oa_finite_private_pilot_stop(p_corp text,p_user text,p_robot text,p_conversation text,p_target uuid,p_invalid boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.finite_private_pilots;
BEGIN
 PERFORM public.oa_formal_state(NULL);
 SELECT * INTO p FROM public.finite_private_pilots WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid;
 IF NOT FOUND THEN RETURN jsonb_build_object('handled',false);END IF;
 IF p_invalid IS DISTINCT FROM false OR (p.document->>'corpId',p.document->>'externalUserId',p.document->>'robotCode',p.document->>'conversationId') IS DISTINCT FROM(p_corp,p_user,p_robot,p_conversation)
 OR p_target IS NOT NULL AND p_target IS DISTINCT FROM p.task_id THEN RETURN jsonb_build_object('handled',true);END IF;
 UPDATE public.finite_private_pilots SET stopped_at=coalesce(stopped_at,clock_timestamp()) WHERE tenant_id=p.tenant_id AND id=p.id;
 RETURN jsonb_build_object('handled',true,'taskId',p.task_id);
END $$;
REVOKE ALL ON FUNCTION public.oa_finite_private_pilot_stop(text,text,text,text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_finite_private_pilot_stop(text,text,text,text,uuid,boolean) TO oa_runtime;

-- Separate narrowly reviewed private grant/bootstrap. Never opens H5 tenant
-- administration or grants GROUP/DWS/WRITE access. All effects are one TX.
CREATE FUNCTION public.oa_finite_private_pilot_bootstrap(p_document text,p_hash text,p_key text,p_formal text,p_manifest uuid,p_descriptor text,p_grant_review text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d jsonb;f jsonb;t uuid;o uuid;m public.permission_manifests;b public.capability_bindings;prior public.finite_private_pilots;g uuid=gen_random_uuid();
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'FINITE_PILOT_MIGRATOR_REQUIRED';END IF;
 IF p_document IS NULL OR octet_length(p_document)>32768 OR p_formal IS NULL OR octet_length(p_formal)>131072 OR p_hash IS DISTINCT FROM encode(sha256(convert_to(p_document,'UTF8')),'hex') THEN RAISE EXCEPTION 'FINITE_PILOT_PROFILE_INVALID';END IF;
 d:=p_document::jsonb;f:=p_formal::jsonb;t:=(d->>'tenantId')::uuid;o:=(d->>'actorId')::uuid;
 IF encode(sha256(convert_to(p_formal,'UTF8')),'hex') IS DISTINCT FROM d->>'formalProfileHash' OR f->>'authorizationId' IS DISTINCT FROM d->>'formalAuthorizationId'
 OR p_grant_review IS DISTINCT FROM d->>'enterpriseApprovalReference' OR coalesce(p_grant_review,'')!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$' OR length(p_grant_review)>512
 OR p_grant_review IN(d->>'reviewReference',d->>'modelApprovalReference',f->>'approvalReference') OR coalesce(p_descriptor,'')!~'^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'FINITE_PILOT_INDEPENDENT_GRANT_REVIEW_REQUIRED';END IF;
 SELECT * INTO prior FROM public.finite_private_pilots WHERE tenant_id=t AND owner_id=o;
 IF FOUND THEN RETURN public.oa_finite_private_pilot_register(p_document,p_hash,p_key,d->>'reviewReference');END IF;
 -- Retains the original irreversible trial/formal and budget transition checks.
 PERFORM public.oa_formal_authorize(p_formal,d->>'sourceTrialProfileHash',f->>'approvalReference');
 SELECT x.* INTO m FROM public.permission_manifests x JOIN public.permission_manifest_heads h ON h.tenant_id=x.tenant_id AND h.manifest_id=x.id AND h.capability_id=x.capability_id AND h.capability_version=x.capability_version
 WHERE x.tenant_id=t AND x.id=p_manifest AND x.capability_id='company.agent.ask' AND x.capability_version='1.0.0';
 SELECT * INTO b FROM public.capability_bindings WHERE tenant_id=t AND logical_id='company.agent.ask' AND semantic_version='1.0.0' AND state='READY' AND risk='READ';
 IF m.id IS NULL OR b.id IS NULL OR m.binding_hash IS DISTINCT FROM b.schema_hash OR f->'capabilities' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('id','company.agent.ask','version','1.0.0','bindingHash',b.schema_hash))
 OR m.descriptor->>'risk' IS DISTINCT FROM 'READ' OR m.descriptor->>'provider' IS DISTINCT FROM 'MCP' OR m.descriptor->>'authMode' IS DISTINCT FROM 'SERVICE' OR coalesce(m.descriptor->>'inputSchemaHash','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'FINITE_PILOT_REVIEWED_MANIFEST_REQUIRED';END IF;
 INSERT INTO public.resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at,managed_capability_version,managed_binding_hash,managed_manifest_id,managed_descriptor_hash)
 VALUES(t,g,o,'company.agent.ask',d->>'enterpriseResourceId','PRIVATE_USER',o::text,'RESTRICTED',(d->>'expiresAt')::timestamptz,'1.0.0',b.schema_hash,m.id,p_descriptor);
 PERFORM public.oa_finite_private_pilot_register(p_document,p_hash,p_key,d->>'reviewReference');
 RETURN jsonb_build_object('id',d->>'id','grantId',g,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_finite_private_pilot_bootstrap(text,text,text,text,uuid,text,text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;

-- Removing a process profile or replacing formal authorization cannot bypass
-- a registered finite owner. All original lifecycle checks remain prerequisites.
ALTER FUNCTION public.oa_formal_state(text) RENAME TO oa_formal_state_v100;
REVOKE ALL ON FUNCTION public.oa_formal_state_v100(text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_formal_state(p_service text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE base jsonb;p public.finite_private_pilots;reason text;
BEGIN
 base:=public.oa_formal_state_v100(p_service);
 SELECT * INTO p FROM public.finite_private_pilots WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid;
 IF NOT FOUND THEN RETURN base;END IF;
 IF base IS NULL OR p.document->>'formalProfileHash' IS DISTINCT FROM nullif(current_setting('app.formal_profile_hash',true),'') THEN reason:='FINITE_PILOT_PROFILE_REQUIRED';
 ELSIF p.stopped_at IS NOT NULL THEN reason:='FINITE_PILOT_STOPPED';
 ELSIF p.valid_from>clock_timestamp() OR p.expires_at<=clock_timestamp() THEN reason:='FINITE_PILOT_EXPIRED';END IF;
 RETURN coalesce(base,'{"mode":"FORMAL","restricted":true,"allowed":false}'::jsonb)||CASE WHEN reason IS NOT NULL THEN jsonb_build_object('allowed',false,'reason',reason) ELSE '{}'::jsonb END;
END $$;
REVOKE ALL ON FUNCTION public.oa_formal_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_formal_state(text) TO oa_app,oa_runtime;
