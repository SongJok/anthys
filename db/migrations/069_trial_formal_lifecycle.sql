-- Explicit formal authorization is separate from the irreversible trial row.
-- This migration provisions no authorization, budget or runtime profile.
CREATE TABLE public.formal_authorizations (
 tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),id uuid NOT NULL,owner_id uuid NOT NULL,
 source_trial_profile_hash text NOT NULL CHECK(source_trial_profile_hash~'^[a-f0-9]{64}$'),
 source_trial_snapshot_hash text NOT NULL CHECK(source_trial_snapshot_hash~'^[a-f0-9]{64}$'),
 profile_hash text NOT NULL CHECK(profile_hash~'^[a-f0-9]{64}$'),profile_document jsonb NOT NULL CHECK(jsonb_typeof(profile_document)='object'),
 auth_epoch bigint NOT NULL CHECK(auth_epoch>0),budget_policy_hash text NOT NULL CHECK(budget_policy_hash~'^[a-f0-9]{64}$'),
 valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL CHECK(valid_until>valid_from),
 approval_reference text NOT NULL,model_allowed boolean NOT NULL,model_approval_reference text,
 state text NOT NULL DEFAULT 'AUTHORIZED' CHECK(state IN ('AUTHORIZED','REVOKED')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,revoke_reason text,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK(model_allowed=(model_approval_reference IS NOT NULL)),CHECK((state='REVOKED')=(revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE UNIQUE INDEX formal_one_authorized_owner ON public.formal_authorizations(tenant_id,owner_id) WHERE state='AUTHORIZED';
CREATE TABLE public.formal_lifecycle_events (
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),owner_id uuid NOT NULL,authorization_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('AUTHORIZE','REVOKE')),profile_hash text NOT NULL,approval_reference text NOT NULL,
 operator_role text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,authorization_id) REFERENCES public.formal_authorizations(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id)
);
CREATE TABLE public.formal_admissions (
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),owner_id uuid NOT NULL,authorization_id uuid NOT NULL,
 msg_id text NOT NULL,conversation_id text NOT NULL,event_created_ms bigint NOT NULL CHECK(event_created_ms>0),candidate_task_id uuid NOT NULL,candidate_run_id uuid NOT NULL,
 task_id uuid,run_id uuid,admitted_txid bigint NOT NULL DEFAULT txid_current(),admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,msg_id),UNIQUE(tenant_id,candidate_task_id),UNIQUE(tenant_id,candidate_run_id),
 FOREIGN KEY(tenant_id,authorization_id) REFERENCES public.formal_authorizations(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES public.tasks(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,run_id) REFERENCES public.runs(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(task_id IS NULL OR task_id=candidate_task_id),CHECK(run_id IS NULL OR run_id=candidate_run_id),CHECK(run_id IS NULL OR task_id IS NOT NULL)
);
ALTER TABLE public.formal_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.formal_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.formal_admissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY formal_authorization_owner ON public.formal_authorizations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY formal_event_owner ON public.formal_lifecycle_events USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY formal_admission_owner ON public.formal_admissions USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON public.formal_authorizations,public.formal_lifecycle_events,public.formal_admissions TO oa_runtime;
CREATE FUNCTION public.oa_formal_authorization_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FORMAL_AUTHORIZATION_DELETE_FORBIDDEN';END IF;
 IF OLD.state='REVOKED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'FORMAL_REVOKED_IMMUTABLE';END IF;
 IF (to_jsonb(NEW)-ARRAY['state','revoked_at','revoke_reason']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revoked_at','revoke_reason']) THEN RAISE EXCEPTION 'FORMAL_PROFILE_IMMUTABLE';END IF;
 IF NEW.state<>'REVOKED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'FORMAL_REOPEN_FORBIDDEN';END IF;RETURN NEW;
END $$;
CREATE TRIGGER formal_authorization_immutable BEFORE UPDATE OR DELETE ON public.formal_authorizations FOR EACH ROW EXECUTE FUNCTION public.oa_formal_authorization_immutable();
CREATE FUNCTION public.oa_formal_event_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'FORMAL_EVENT_IMMUTABLE';END $$;
CREATE TRIGGER formal_event_immutable BEFORE UPDATE OR DELETE ON public.formal_lifecycle_events FOR EACH ROW EXECUTE FUNCTION public.oa_formal_event_immutable();
CREATE FUNCTION public.oa_formal_authorize(p_document text,p_expected_trial_hash text,p_approval_ref text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE doc jsonb;slot public.one_shot_trials;subject public.users;existing public.formal_authorizations;tenant uuid;actor uuid;auth_id uuid;digest text;first_at timestamptz;last_at timestamptz;
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'FORMAL_MIGRATOR_REQUIRED';END IF;
 IF octet_length(p_document)>131072 THEN RAISE EXCEPTION 'FORMAL_PROFILE_SIZE_LIMIT';END IF;
 doc:=p_document::jsonb;
 IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR jsonb_typeof(doc->'schemaVersion') IS DISTINCT FROM 'number' OR doc->>'schemaVersion'<>'1' OR (SELECT count(*) FROM jsonb_object_keys(doc))<>18
  OR NOT doc ?& ARRAY['schemaVersion','authorizationId','tenantId','actorId','sourceTrialProfileHash','corpId','externalUserId','robotCode','conversationId','validFrom','validUntil','budgetPolicyHash','approvalReference','modelAllowed','modelApprovalReference','entrypoints','inputPolicy','capabilities']
 THEN RAISE EXCEPTION 'FORMAL_PROFILE_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['authorizationId','tenantId','actorId','sourceTrialProfileHash','corpId','externalUserId','robotCode','conversationId','validFrom','validUntil','budgetPolicyHash','approvalReference']) k WHERE jsonb_typeof(doc->k) IS DISTINCT FROM 'string' OR length(doc->>k)=0) THEN RAISE EXCEPTION 'FORMAL_PROFILE_FIELD_TYPE_INVALID';END IF;
 IF doc->>'sourceTrialProfileHash' !~ '^[a-f0-9]{64}$' OR doc->>'budgetPolicyHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'FORMAL_PROFILE_BINDING_HASH_INVALID';END IF;
 tenant:=(doc->>'tenantId')::uuid;actor:=(doc->>'actorId')::uuid;auth_id:=(doc->>'authorizationId')::uuid;
 digest:=encode(sha256(convert_to(p_document,'UTF8')),'hex');first_at:=(doc->>'validFrom')::timestamptz;last_at:=(doc->>'validUntil')::timestamptz;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=tenant FOR UPDATE;
 IF NOT FOUND OR slot.state<>'CLOSED' OR slot.owner_id<>actor OR slot.profile_hash IS DISTINCT FROM p_expected_trial_hash OR slot.profile_hash IS DISTINCT FROM doc->>'sourceTrialProfileHash'
  OR (slot.corp_id,slot.external_user_id,slot.robot_code,slot.conversation_id) IS DISTINCT FROM(doc->>'corpId',doc->>'externalUserId',doc->>'robotCode',doc->>'conversationId')
 THEN RAISE EXCEPTION 'FORMAL_CLOSED_TRIAL_BINDING_REQUIRED';END IF;
 IF (doc->>'approvalReference') IS DISTINCT FROM p_approval_ref OR length(p_approval_ref)>512 OR p_approval_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$' THEN RAISE EXCEPTION 'FORMAL_APPROVAL_REFERENCE_MISMATCH';END IF;
 IF last_at<=clock_timestamp() OR last_at<=first_at THEN RAISE EXCEPTION 'FORMAL_VALIDITY_WINDOW_INVALID';END IF;
 SELECT u.* INTO subject FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=tenant AND u.id=actor AND u.status='ACTIVE' AND t.status='ACTIVE' AND u.external_user_id=slot.external_user_id AND t.corp_id=slot.corp_id FOR UPDATE OF u;
 IF NOT FOUND THEN RAISE EXCEPTION 'FORMAL_IDENTITY_INACTIVE';END IF;
 IF doc->>'budgetPolicyHash' IS DISTINCT FROM slot.budget_policy_hash OR EXISTS(SELECT 1 FROM public.budget_policies b WHERE b.tenant_id=tenant AND (b.policy_hash IS DISTINCT FROM doc->>'budgetPolicyHash' OR b.valid_until<=clock_timestamp() OR b.blocked_reason IS NOT NULL)) THEN RAISE EXCEPTION 'FORMAL_APPROVED_BUDGET_MISMATCH';END IF;
 IF jsonb_typeof(doc->'modelAllowed') IS DISTINCT FROM 'boolean' OR ((doc->>'modelAllowed')::boolean AND jsonb_typeof(doc->'modelApprovalReference') IS DISTINCT FROM 'string') OR (NOT (doc->>'modelAllowed')::boolean AND jsonb_typeof(doc->'modelApprovalReference') IS DISTINCT FROM 'null') OR ((doc->>'modelAllowed')::boolean AND (length(doc->>'modelApprovalReference')>512 OR (doc->>'modelApprovalReference') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$')) THEN RAISE EXCEPTION 'FORMAL_MODEL_APPROVAL_REQUIRED';END IF;
 IF jsonb_typeof(doc->'entrypoints') IS DISTINCT FROM 'array' OR jsonb_array_length(doc->'entrypoints') NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(doc->'entrypoints') x WHERE x IS NULL OR x NOT IN ('INGRESS','WORKER','NOTIFIER','API','MAINTENANCE')) OR (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(doc->'entrypoints') x)<>jsonb_array_length(doc->'entrypoints') THEN RAISE EXCEPTION 'FORMAL_ENTRYPOINTS_INVALID';END IF;
 IF jsonb_typeof(doc->'inputPolicy') IS DISTINCT FROM 'object' OR NOT (doc->'inputPolicy') ?& ARRAY['attachments','controls'] OR (SELECT count(*) FROM jsonb_object_keys(doc->'inputPolicy'))<>2 OR jsonb_typeof(doc->'inputPolicy'->'attachments') IS DISTINCT FROM 'boolean' OR jsonb_typeof(doc->'inputPolicy'->'controls') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'FORMAL_INPUT_POLICY_INVALID';END IF;
 IF jsonb_typeof(doc->'capabilities') IS DISTINCT FROM 'array' OR jsonb_array_length(doc->'capabilities')>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'capabilities') c WHERE jsonb_typeof(c) IS DISTINCT FROM 'object' OR jsonb_typeof(c->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'version') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'bindingHash') IS DISTINCT FROM 'string' OR NOT c ?& ARRAY['id','version','bindingHash'] OR (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR c->>'id' !~ '^[a-z][a-z0-9_.-]{0,127}$' OR c->>'version' !~ '^\d+\.\d+\.\d+$' OR c->>'bindingHash' !~ '^[a-f0-9]{64}$') OR (SELECT count(DISTINCT(c->>'id',c->>'version')) FROM jsonb_array_elements(doc->'capabilities') c)<>jsonb_array_length(doc->'capabilities') THEN RAISE EXCEPTION 'FORMAL_CAPABILITY_SCOPE_INVALID';END IF;
 SELECT * INTO existing FROM public.formal_authorizations WHERE tenant_id=tenant AND id=auth_id FOR UPDATE;
 IF FOUND THEN IF existing.profile_hash=digest AND existing.state='AUTHORIZED' THEN RETURN jsonb_build_object('id',auth_id,'state','AUTHORIZED','replayed',true,'profileHash',digest);END IF;RAISE EXCEPTION 'FORMAL_AUTHORIZATION_ID_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=tenant AND owner_id=actor AND state='AUTHORIZED') THEN RAISE EXCEPTION 'FORMAL_AUTHORIZATION_ALREADY_EXISTS';END IF;
 INSERT INTO public.formal_authorizations(tenant_id,id,owner_id,source_trial_profile_hash,source_trial_snapshot_hash,profile_hash,profile_document,auth_epoch,budget_policy_hash,valid_from,valid_until,approval_reference,model_allowed,model_approval_reference)
 VALUES(tenant,auth_id,actor,slot.profile_hash,encode(sha256(convert_to(to_jsonb(slot)::text,'UTF8')),'hex'),digest,doc,subject.auth_epoch,slot.budget_policy_hash,first_at,last_at,p_approval_ref,(doc->>'modelAllowed')::boolean,doc->>'modelApprovalReference');
 INSERT INTO public.formal_lifecycle_events(tenant_id,owner_id,authorization_id,operation,profile_hash,approval_reference,operator_role) VALUES(tenant,actor,auth_id,'AUTHORIZE',digest,p_approval_ref,current_user);
 RETURN jsonb_build_object('id',auth_id,'state','AUTHORIZED','replayed',false,'profileHash',digest);
END $$;
CREATE FUNCTION public.oa_formal_revoke(p_id uuid,p_expected_hash text,p_reason text,p_review_ref text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE auth public.formal_authorizations;
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'FORMAL_MIGRATOR_REQUIRED';END IF;
 IF p_reason IS NULL OR p_review_ref IS NULL OR length(p_reason) NOT BETWEEN 1 AND 128 OR length(p_review_ref)>512 OR p_review_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$' THEN RAISE EXCEPTION 'FORMAL_REVOCATION_REVIEW_REQUIRED';END IF;
 SELECT * INTO auth FROM public.formal_authorizations WHERE id=p_id AND profile_hash=p_expected_hash;IF NOT FOUND OR auth.profile_hash IS DISTINCT FROM p_expected_hash THEN RAISE EXCEPTION 'FORMAL_AUTHORIZATION_NOT_FOUND';END IF;
 PERFORM 1 FROM public.one_shot_trials WHERE tenant_id=auth.tenant_id FOR UPDATE;
 SELECT * INTO auth FROM public.formal_authorizations WHERE tenant_id=auth.tenant_id AND id=p_id FOR UPDATE;
 IF auth.state='REVOKED' THEN RETURN jsonb_build_object('id',p_id,'state','REVOKED','replayed',true);END IF;
 UPDATE public.formal_authorizations SET state='REVOKED',revoked_at=clock_timestamp(),revoke_reason=p_reason WHERE tenant_id=auth.tenant_id AND id=p_id;
 INSERT INTO public.formal_lifecycle_events(tenant_id,owner_id,authorization_id,operation,profile_hash,approval_reference,operator_role) VALUES(auth.tenant_id,auth.owner_id,p_id,'REVOKE',auth.profile_hash,p_review_ref,current_user);
 RETURN jsonb_build_object('id',p_id,'state','REVOKED','replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_formal_authorization_immutable(),public.oa_formal_event_immutable(),public.oa_formal_authorize(text,text,text),public.oa_formal_revoke(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_formal_authorize(text,text,text),public.oa_formal_revoke(uuid,text,text,text) TO oa_migrator;
CREATE FUNCTION public.oa_formal_state(p_service text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE attestation text;tenant uuid;actor uuid;slot public.one_shot_trials;auth public.formal_authorizations;reason text;
BEGIN
 attestation:=nullif(current_setting('app.formal_profile_hash',true),'');IF attestation IS NULL THEN RETURN NULL;END IF;
 tenant:=nullif(current_setting('app.tenant_id',true),'')::uuid;actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=tenant FOR UPDATE;
 IF NOT FOUND OR slot.owner_id IS DISTINCT FROM actor OR slot.state<>'CLOSED' THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'reason','FORMAL_CLOSED_TRIAL_BINDING_REQUIRED');END IF;
 SELECT * INTO auth FROM public.formal_authorizations WHERE tenant_id=tenant AND owner_id=actor AND profile_hash=attestation FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'reason','FORMAL_PROFILE_NOT_AUTHORIZED');END IF;
 IF auth.state<>'AUTHORIZED' THEN reason:='FORMAL_AUTHORIZATION_REVOKED';
 ELSIF auth.valid_from>clock_timestamp() OR auth.valid_until<=clock_timestamp() THEN reason:='FORMAL_AUTHORIZATION_EXPIRED';
 ELSIF auth.source_trial_profile_hash IS DISTINCT FROM slot.profile_hash OR auth.source_trial_snapshot_hash IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(slot)::text,'UTF8')),'hex') THEN reason:='FORMAL_TRIAL_TOMBSTONE_CHANGED';
 ELSIF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=tenant AND u.id=actor AND u.status='ACTIVE' AND t.status='ACTIVE' AND u.auth_epoch=auth.auth_epoch AND u.external_user_id=slot.external_user_id AND t.corp_id=slot.corp_id) THEN reason:='FORMAL_IDENTITY_CHANGED';
 ELSIF p_service IS NOT NULL AND NOT (auth.profile_document->'entrypoints') ? p_service THEN reason:='FORMAL_ENTRYPOINT_NOT_APPROVED';
 END IF;
 RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',reason IS NULL,'reason',reason,'authorizationId',auth.id,'tenantId',tenant,'actorId',actor,'corpId',slot.corp_id,'robotCode',slot.robot_code,'conversationId',slot.conversation_id,'budgetPolicyHash',auth.budget_policy_hash,'modelAllowed',auth.model_allowed,'capabilities',auth.profile_document->'capabilities','inputPolicy',auth.profile_document->'inputPolicy','admissionCutoffMs',ceil(extract(epoch FROM greatest(auth.valid_from,auth.created_at))*1000)::bigint,'deadline',auth.valid_until);
END $$;
REVOKE ALL ON FUNCTION public.oa_formal_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_formal_state(text) TO oa_app,oa_runtime;
CREATE FUNCTION public.oa_formal_admission_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FORMAL_ADMISSION_DELETE_FORBIDDEN';END IF;
 IF (to_jsonb(NEW)-ARRAY['task_id','run_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['task_id','run_id']) THEN RAISE EXCEPTION 'FORMAL_ADMISSION_METADATA_IMMUTABLE';END IF;
 IF OLD.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM OLD.task_id OR OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN RAISE EXCEPTION 'FORMAL_ADMISSION_REBIND_FORBIDDEN';END IF;
 IF NEW.task_id IS DISTINCT FROM OLD.task_id AND NEW.task_id IS DISTINCT FROM OLD.candidate_task_id OR NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS DISTINCT FROM OLD.candidate_run_id THEN RAISE EXCEPTION 'FORMAL_ADMISSION_BINDING_MISMATCH';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER formal_admission_immutable BEFORE UPDATE OR DELETE ON public.formal_admissions FOR EACH ROW EXECUTE FUNCTION public.oa_formal_admission_immutable();
REVOKE ALL ON FUNCTION public.oa_formal_admission_immutable() FROM PUBLIC;
-- The original trial evaluator stays private and unchanged. Formal approval
-- never rewrites CLOSED and never turns the tenant into an unrestricted mode.
ALTER FUNCTION public.oa_trial_check(uuid,boolean,text) RENAME TO oa_trial_check_schema68;
REVOKE ALL ON FUNCTION public.oa_trial_check_schema68(uuid,boolean,text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_trial_check(p_run uuid DEFAULT NULL,p_recovery boolean DEFAULT false,p_close text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE formal jsonb;receipt public.formal_admissions;slot public.one_shot_trials;
BEGIN
 formal:=public.oa_formal_state();IF formal IS NULL THEN IF EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) THEN RETURN jsonb_build_object('mode','FORMAL','restricted',true,'allowed',false,'reason','FORMAL_PROFILE_REQUIRED');END IF;RETURN public.oa_trial_check_schema68(p_run,p_recovery,p_close);END IF;
 IF NOT (formal->>'allowed')::boolean THEN RETURN formal;END IF;
 IF p_run IS NULL THEN RETURN formal;END IF;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF p_run=slot.run_id THEN RETURN formal||jsonb_build_object('allowed',false,'reason','CLOSED_TRIAL_RUN_NEVER_RESUMES');END IF;
 SELECT * INTO receipt FROM public.formal_admissions WHERE tenant_id=slot.tenant_id AND owner_id=slot.owner_id AND authorization_id=(formal->>'authorizationId')::uuid AND candidate_run_id=p_run;
 IF NOT FOUND OR receipt.run_id IS NULL AND receipt.admitted_txid<>txid_current() THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_RUN_NOT_ADMITTED');END IF;
 RETURN formal||jsonb_build_object('taskId',receipt.candidate_task_id,'runId',receipt.candidate_run_id,'msgId',receipt.msg_id);
END $$;
REVOKE ALL ON FUNCTION public.oa_trial_check(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_trial_check(uuid,boolean,text) TO oa_app,oa_runtime;
-- Dispatch selection uses the same per-run receipt before LIMIT/claim. Ordinary
-- installations without a trial retain their existing authorization behavior.
CREATE FUNCTION public.oa_lifecycle_run_allowed(p_run uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=public.oa_trial_check(p_run,true,NULL);
 IF p_run IS NULL THEN RETURN coalesce(NOT (result->>'restricted')::boolean,false);END IF;
 RETURN coalesce(NOT (result->>'restricted')::boolean OR (result->>'allowed')::boolean,false);
END $$;
REVOKE ALL ON FUNCTION public.oa_lifecycle_run_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_lifecycle_run_allowed(uuid) TO oa_app,oa_runtime;
CREATE FUNCTION public.oa_lifecycle_admit(p_corp text,p_employee text,p_robot text,p_conversation text,p_msg text,p_trial_eligible boolean,p_task uuid,p_run uuid,p_created_ms bigint,p_channel text,p_attachments boolean,p_control boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE formal jsonb;slot public.one_shot_trials;receipt public.formal_admissions;existing_task uuid;tenant uuid;actor uuid;
BEGIN
 formal:=public.oa_formal_state('INGRESS');IF formal IS NULL THEN RETURN public.oa_trial_admit(p_corp,p_employee,p_robot,p_conversation,p_msg,p_trial_eligible,p_task,p_run);END IF;
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
CREATE OR REPLACE FUNCTION public.oa_trial_task_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE slot public.one_shot_trials;formal jsonb;receipt public.formal_admissions;
BEGIN
 formal:=public.oa_formal_state();
 IF formal IS NOT NULL THEN
  IF NOT (formal->>'allowed')::boolean OR NEW.tenant_id IS DISTINCT FROM (formal->>'tenantId')::uuid OR NEW.requester_id IS DISTINCT FROM (formal->>'actorId')::uuid THEN RAISE EXCEPTION 'FORMAL_TASK_CREATION_FORBIDDEN';END IF;
  SELECT * INTO receipt FROM public.formal_admissions WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.requester_id AND authorization_id=(formal->>'authorizationId')::uuid AND candidate_task_id=NEW.id AND task_id IS NULL AND admitted_txid=txid_current() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FORMAL_TASK_ADMISSION_REQUIRED';END IF;
  UPDATE public.formal_admissions SET task_id=NEW.id WHERE tenant_id=receipt.tenant_id AND id=receipt.id;RETURN NEW;
 END IF;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=NEW.tenant_id FOR UPDATE;
 IF FOUND AND (slot.state<>'BOUND' OR NEW.id IS DISTINCT FROM slot.task_id OR NEW.requester_id IS DISTINCT FROM slot.owner_id OR slot.deadline<=clock_timestamp() OR slot.profile_hash IS DISTINCT FROM nullif(current_setting('app.trial_profile_hash',true),'')) THEN RAISE EXCEPTION 'TRIAL_TASK_CREATION_FORBIDDEN';END IF;RETURN NEW;
END $$;
CREATE FUNCTION public.oa_formal_run_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE formal jsonb;receipt public.formal_admissions;slot public.one_shot_trials;
BEGIN
 formal:=public.oa_formal_state();
 IF formal IS NOT NULL THEN
  IF NOT (formal->>'allowed')::boolean OR NEW.tenant_id IS DISTINCT FROM (formal->>'tenantId')::uuid OR NEW.owner_id IS DISTINCT FROM (formal->>'actorId')::uuid THEN RAISE EXCEPTION 'FORMAL_RUN_CREATION_FORBIDDEN';END IF;
  SELECT * INTO receipt FROM public.formal_admissions WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id AND authorization_id=(formal->>'authorizationId')::uuid AND candidate_run_id=NEW.id AND task_id=NEW.task_id AND run_id IS NULL AND admitted_txid=txid_current() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FORMAL_RUN_ADMISSION_REQUIRED';END IF;
  UPDATE public.formal_admissions SET run_id=NEW.id WHERE tenant_id=receipt.tenant_id AND id=receipt.id;RETURN NEW;
 END IF;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=NEW.tenant_id FOR UPDATE;
 IF FOUND AND (slot.state<>'BOUND' OR NEW.id IS DISTINCT FROM slot.run_id OR NEW.task_id IS DISTINCT FROM slot.task_id OR NEW.owner_id IS DISTINCT FROM slot.owner_id OR slot.profile_hash IS DISTINCT FROM nullif(current_setting('app.trial_profile_hash',true),'')) THEN RAISE EXCEPTION 'TRIAL_RUN_CREATION_FORBIDDEN';END IF;RETURN NEW;
END $$;
CREATE TRIGGER formal_run_creation BEFORE INSERT ON public.runs FOR EACH ROW EXECUTE FUNCTION public.oa_formal_run_guard();
REVOKE ALL ON FUNCTION public.oa_formal_run_guard() FROM PUBLIC;
CREATE FUNCTION public.oa_lifecycle_bootstrap(p_trial_hash text,p_formal_hash text,p_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_service IS NULL OR p_service NOT IN ('INGRESS','WORKER','NOTIFIER','API','MAINTENANCE') THEN RETURN jsonb_build_object('blocked',true,'reason','LIFECYCLE_SERVICE_INVALID');END IF;
 IF p_formal_hash IS NULL THEN
  IF nullif(current_setting('app.formal_profile_hash',true),'') IS NOT NULL THEN RETURN jsonb_build_object('blocked',true,'reason','FORMAL_PROFILE_MISMATCH');END IF;
  result:=public.oa_trial_bootstrap(p_trial_hash);RETURN CASE WHEN result IS NULL THEN NULL ELSE result||jsonb_build_object('mode','TRIAL') END;
 END IF;
 IF p_trial_hash IS NOT NULL OR nullif(current_setting('app.trial_profile_hash',true),'') IS NOT NULL OR p_formal_hash IS DISTINCT FROM nullif(current_setting('app.formal_profile_hash',true),'') THEN RETURN jsonb_build_object('blocked',true,'reason','LIFECYCLE_PROFILE_CONFLICT');END IF;
 result:=public.oa_formal_state(p_service);
 IF result IS NULL THEN RETURN jsonb_build_object('blocked',true,'reason','FORMAL_PROFILE_REQUIRED');END IF;
 RETURN result||jsonb_build_object('blocked',NOT (result->>'allowed')::boolean);
END $$;
REVOKE ALL ON FUNCTION public.oa_lifecycle_bootstrap(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_lifecycle_bootstrap(text,text,text) TO oa_app,oa_runtime;
