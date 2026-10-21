-- Explicit reviewed window transition. No row, budget, approval or service is activated by migration.
-- budget_policies is the current projection; immutable transition snapshots retain every replaced version.
CREATE TABLE public.budget_policy_transitions (
 tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),id uuid NOT NULL,owner_id uuid NOT NULL,
 source_trial_profile_hash text NOT NULL,previous_policy_hash text NOT NULL,next_policy_hash text NOT NULL,
 previous_policy_version bigint NOT NULL CHECK(previous_policy_version>0),
 previous_policy jsonb NOT NULL,next_policy jsonb NOT NULL,request_document jsonb NOT NULL,request_hash text NOT NULL,
 formal_authorization_id uuid NOT NULL,formal_profile_hash text NOT NULL,review_reference text NOT NULL,
 operator_role text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,next_policy_hash),UNIQUE(tenant_id,formal_profile_hash),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,formal_authorization_id) REFERENCES public.formal_authorizations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(previous_policy_hash<>next_policy_hash),
 CHECK(source_trial_profile_hash~'^[a-f0-9]{64}$' AND previous_policy_hash~'^[a-f0-9]{64}$' AND next_policy_hash~'^[a-f0-9]{64}$'
  AND request_hash~'^[a-f0-9]{64}$' AND formal_profile_hash~'^[a-f0-9]{64}$')
);
ALTER TABLE public.budget_policy_transitions ENABLE ROW LEVEL SECURITY;
-- No application/runtime table access, no changes to existing grants or RLS.
CREATE FUNCTION public.oa_budget_transition_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'BUDGET_TRANSITION_IMMUTABLE';END $$;
CREATE TRIGGER budget_transition_immutable BEFORE UPDATE OR DELETE ON public.budget_policy_transitions FOR EACH ROW EXECUTE FUNCTION public.oa_budget_transition_immutable();
REVOKE ALL ON FUNCTION public.oa_budget_transition_immutable() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.oa_formal_authorize(p_document text,p_expected_trial_hash text,p_approval_ref text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
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
 IF NOT (doc->>'budgetPolicyHash'=slot.budget_policy_hash OR EXISTS(
  SELECT 1 FROM public.budget_policy_transitions x WHERE x.tenant_id=tenant AND x.owner_id=actor
   AND x.source_trial_profile_hash=slot.profile_hash AND x.next_policy_hash=doc->>'budgetPolicyHash'
   AND x.formal_profile_hash=digest AND x.formal_authorization_id=auth_id)) OR EXISTS(SELECT 1 FROM public.budget_policies b WHERE b.tenant_id=tenant AND (b.policy_hash IS DISTINCT FROM doc->>'budgetPolicyHash' OR b.valid_until<=clock_timestamp() OR b.blocked_reason IS NOT NULL)) THEN RAISE EXCEPTION 'FORMAL_APPROVED_BUDGET_MISMATCH';END IF;
 IF jsonb_typeof(doc->'modelAllowed') IS DISTINCT FROM 'boolean' OR ((doc->>'modelAllowed')::boolean AND jsonb_typeof(doc->'modelApprovalReference') IS DISTINCT FROM 'string') OR (NOT (doc->>'modelAllowed')::boolean AND jsonb_typeof(doc->'modelApprovalReference') IS DISTINCT FROM 'null') OR ((doc->>'modelAllowed')::boolean AND (length(doc->>'modelApprovalReference')>512 OR (doc->>'modelApprovalReference') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$')) THEN RAISE EXCEPTION 'FORMAL_MODEL_APPROVAL_REQUIRED';END IF;
 IF jsonb_typeof(doc->'entrypoints') IS DISTINCT FROM 'array' OR jsonb_array_length(doc->'entrypoints') NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(doc->'entrypoints') x WHERE x IS NULL OR x NOT IN ('INGRESS','WORKER','NOTIFIER','API','MAINTENANCE')) OR (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(doc->'entrypoints') x)<>jsonb_array_length(doc->'entrypoints') THEN RAISE EXCEPTION 'FORMAL_ENTRYPOINTS_INVALID';END IF;
 IF jsonb_typeof(doc->'inputPolicy') IS DISTINCT FROM 'object' OR NOT (doc->'inputPolicy') ?& ARRAY['attachments','controls'] OR (SELECT count(*) FROM jsonb_object_keys(doc->'inputPolicy'))<>2 OR jsonb_typeof(doc->'inputPolicy'->'attachments') IS DISTINCT FROM 'boolean' OR jsonb_typeof(doc->'inputPolicy'->'controls') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'FORMAL_INPUT_POLICY_INVALID';END IF;
 IF jsonb_typeof(doc->'capabilities') IS DISTINCT FROM 'array' OR jsonb_array_length(doc->'capabilities')>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'capabilities') c WHERE jsonb_typeof(c) IS DISTINCT FROM 'object' OR jsonb_typeof(c->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'version') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'bindingHash') IS DISTINCT FROM 'string' OR NOT c ?& ARRAY['id','version','bindingHash'] OR (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR c->>'id' !~ '^[a-z][a-z0-9_.-]{0,127}$' OR c->>'version' !~ '^\d+\.\d+\.\d+$' OR c->>'bindingHash' !~ '^[a-f0-9]{64}$') OR (SELECT count(DISTINCT(c->>'id',c->>'version')) FROM jsonb_array_elements(doc->'capabilities') c)<>jsonb_array_length(doc->'capabilities') THEN RAISE EXCEPTION 'FORMAL_CAPABILITY_SCOPE_INVALID';END IF;
 SELECT * INTO existing FROM public.formal_authorizations WHERE tenant_id=tenant AND id=auth_id FOR UPDATE;
 IF FOUND THEN IF existing.profile_hash=digest AND existing.state='AUTHORIZED' THEN RETURN jsonb_build_object('id',auth_id,'state','AUTHORIZED','replayed',true,'profileHash',digest);END IF;RAISE EXCEPTION 'FORMAL_AUTHORIZATION_ID_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=tenant AND owner_id=actor AND state='AUTHORIZED') THEN RAISE EXCEPTION 'FORMAL_AUTHORIZATION_ALREADY_EXISTS';END IF;
 INSERT INTO public.formal_authorizations(tenant_id,id,owner_id,source_trial_profile_hash,source_trial_snapshot_hash,profile_hash,profile_document,auth_epoch,budget_policy_hash,valid_from,valid_until,approval_reference,model_allowed,model_approval_reference)
 VALUES(tenant,auth_id,actor,slot.profile_hash,encode(sha256(convert_to(to_jsonb(slot)::text,'UTF8')),'hex'),digest,doc,subject.auth_epoch,doc->>'budgetPolicyHash',first_at,last_at,p_approval_ref,(doc->>'modelAllowed')::boolean,doc->>'modelApprovalReference');
 INSERT INTO public.formal_lifecycle_events(tenant_id,owner_id,authorization_id,operation,profile_hash,approval_reference,operator_role) VALUES(tenant,actor,auth_id,'AUTHORIZE',digest,p_approval_ref,current_user);
 RETURN jsonb_build_object('id',auth_id,'state','AUTHORIZED','replayed',false,'profileHash',digest);
END $$;

CREATE FUNCTION public.oa_budget_transition_authorize(p_request text,p_policy text,p_formal text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE req jsonb;next_doc jsonb;formal_doc jsonb;slot public.one_shot_trials;old public.budget_policies;
 prior public.budget_policy_transitions;tenant uuid;actor uuid;transition_id uuid;request_digest text;policy_digest text;formal_digest text;result jsonb;
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'BUDGET_TRANSITION_MIGRATOR_REQUIRED';END IF;
 IF p_request IS NULL OR p_policy IS NULL OR p_formal IS NULL OR octet_length(p_request)>16384 OR octet_length(p_policy)>131072 OR octet_length(p_formal)>131072 THEN RAISE EXCEPTION 'BUDGET_TRANSITION_DOCUMENT_INVALID';END IF;
 req:=p_request::jsonb;next_doc:=p_policy::jsonb;formal_doc:=p_formal::jsonb;
 IF jsonb_typeof(req) IS DISTINCT FROM 'object' OR req->'schemaVersion' IS DISTINCT FROM '1'::jsonb
  OR (SELECT count(*) FROM jsonb_object_keys(req))<>10
  OR NOT req ?& ARRAY['schemaVersion','transitionId','tenantId','actorId','sourceTrialProfileHash','expectedPolicyHash','expectedPolicyVersion','policyHash','formalProfileHash','reviewReference']
  OR EXISTS(SELECT 1 FROM jsonb_each(req) WHERE key<>'schemaVersion' AND jsonb_typeof(value)<>'string')
 THEN RAISE EXCEPTION 'BUDGET_TRANSITION_REQUEST_INVALID';END IF;
 IF req->>'sourceTrialProfileHash' !~ '^[a-f0-9]{64}$' OR req->>'expectedPolicyHash' !~ '^[a-f0-9]{64}$'
  OR req->>'policyHash' !~ '^[a-f0-9]{64}$' OR req->>'formalProfileHash' !~ '^[a-f0-9]{64}$'
  OR req->>'expectedPolicyVersion' !~ '^[1-9][0-9]{0,17}$' OR length(req->>'reviewReference')>512
  OR req->>'reviewReference' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$'
 THEN RAISE EXCEPTION 'BUDGET_TRANSITION_REVIEW_REQUIRED';END IF;
 tenant:=(req->>'tenantId')::uuid;actor:=(req->>'actorId')::uuid;transition_id:=(req->>'transitionId')::uuid;
 request_digest:=encode(sha256(convert_to(p_request,'UTF8')),'hex');policy_digest:=encode(sha256(convert_to(p_policy,'UTF8')),'hex');formal_digest:=encode(sha256(convert_to(p_formal,'UTF8')),'hex');
 IF policy_digest IS DISTINCT FROM req->>'policyHash' OR formal_digest IS DISTINCT FROM req->>'formalProfileHash'
  OR formal_doc->>'tenantId' IS DISTINCT FROM tenant::text OR formal_doc->>'actorId' IS DISTINCT FROM actor::text
  OR formal_doc->>'budgetPolicyHash' IS DISTINCT FROM policy_digest
 THEN RAISE EXCEPTION 'BUDGET_TRANSITION_BINDING_MISMATCH';END IF;
 -- Same tenant trial lock order as formal authorize/revoke and runtime admission.
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=tenant FOR UPDATE;
 IF NOT FOUND OR slot.owner_id IS DISTINCT FROM actor OR slot.state<>'CLOSED' OR slot.profile_hash IS DISTINCT FROM req->>'sourceTrialProfileHash'
 THEN RAISE EXCEPTION 'BUDGET_TRANSITION_CLOSED_TRIAL_REQUIRED';END IF;
 SELECT * INTO old FROM public.budget_policies WHERE tenant_id=tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BUDGET_TRANSITION_EXISTING_POLICY_REQUIRED';END IF;
 SELECT * INTO prior FROM public.budget_policy_transitions WHERE tenant_id=tenant AND id=transition_id;
 IF FOUND THEN
  IF prior.request_hash=request_digest AND prior.next_policy_hash=policy_digest AND prior.formal_profile_hash=formal_digest
   AND old.policy_hash=policy_digest AND old.version=prior.previous_policy_version+1 AND old.valid_until>clock_timestamp() AND old.blocked_reason IS NULL
   AND EXISTS(SELECT 1 FROM public.formal_authorizations a JOIN public.users u ON u.tenant_id=a.tenant_id AND u.id=a.owner_id JOIN public.tenants t ON t.tenant_id=u.tenant_id
    WHERE a.tenant_id=tenant AND a.id=prior.formal_authorization_id AND a.profile_hash=formal_digest AND a.state='AUTHORIZED' AND a.valid_until>clock_timestamp()
     AND u.status='ACTIVE' AND t.status='ACTIVE' AND u.auth_epoch=a.auth_epoch AND u.external_user_id=slot.external_user_id AND t.corp_id=slot.corp_id)
  THEN RETURN jsonb_build_object('state','AUTHORIZED','replayed',true,'transitionId',transition_id,'policyHash',policy_digest,'profileHash',formal_digest);END IF;
  RAISE EXCEPTION 'BUDGET_TRANSITION_REPLAY_CONFLICT';
 END IF;
 IF old.policy_hash IS DISTINCT FROM req->>'expectedPolicyHash' OR old.version<>(req->>'expectedPolicyVersion')::bigint THEN RAISE EXCEPTION 'BUDGET_TRANSITION_VERSION_CONFLICT';END IF;
 IF old.blocked_reason IS NOT NULL THEN RAISE EXCEPTION 'BUDGET_TRANSITION_BLOCKED_POLICY';END IF;
 IF EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=tenant AND state='AUTHORIZED') THEN RAISE EXCEPTION 'BUDGET_TRANSITION_REVOKE_FORMAL_FIRST';END IF;
 -- Initial protocol deliberately supports windows/references only. Bucket identity,
 -- capacity, provider, ceiling and tariff amounts/cache schema remain exact.
 IF jsonb_typeof(next_doc) IS DISTINCT FROM 'object'
  OR (next_doc-ARRAY['validUntil','approvalReference','pricing']) IS DISTINCT FROM (old.document-ARRAY['validUntil','approvalReference','pricing'])
  OR next_doc->>'approvalReference' IS DISTINCT FROM req->>'reviewReference'
  OR next_doc->>'approvalReference' IS NOT DISTINCT FROM old.document->>'approvalReference'
  OR jsonb_typeof(next_doc->'validUntil') IS DISTINCT FROM 'string'
  OR NOT isfinite((next_doc->>'validUntil')::timestamptz) OR NOT isfinite((formal_doc->>'validUntil')::timestamptz)
  OR (next_doc->>'validUntil')::timestamptz<=clock_timestamp()
  OR (formal_doc->>'validUntil')::timestamptz>(next_doc->>'validUntil')::timestamptz
  OR formal_doc->>'approvalReference' IS NOT DISTINCT FROM req->>'reviewReference'
 THEN RAISE EXCEPTION 'BUDGET_TRANSITION_WINDOW_ONLY';END IF;
 IF old.document->'pricing'='null'::jsonb THEN
  IF next_doc->'pricing' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'BUDGET_TRANSITION_TARIFF_CHANGE_FORBIDDEN';END IF;
 ELSE
  IF jsonb_typeof(next_doc->'pricing') IS DISTINCT FROM 'object'
   OR ((next_doc->'pricing')-ARRAY['validFrom','validUntil','sourceReference']) IS DISTINCT FROM ((old.document->'pricing')-ARRAY['validFrom','validUntil','sourceReference'])
   OR jsonb_typeof(next_doc->'pricing'->'validFrom') IS DISTINCT FROM 'string' OR jsonb_typeof(next_doc->'pricing'->'validUntil') IS DISTINCT FROM 'string'
   OR jsonb_typeof(next_doc->'pricing'->'sourceReference') IS DISTINCT FROM 'string' OR length(next_doc->'pricing'->>'sourceReference') NOT BETWEEN 8 AND 512
   OR NOT isfinite((next_doc->'pricing'->>'validFrom')::timestamptz) OR NOT isfinite((next_doc->'pricing'->>'validUntil')::timestamptz)
   OR (next_doc->'pricing'->>'validFrom')::timestamptz>clock_timestamp()
   OR (next_doc->'pricing'->>'validUntil')::timestamptz<=clock_timestamp()
   OR (next_doc->'pricing'->>'validFrom')::timestamptz>=(next_doc->'pricing'->>'validUntil')::timestamptz
  THEN RAISE EXCEPTION 'BUDGET_TRANSITION_TARIFF_CHANGE_FORBIDDEN';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.formal_authorizations a WHERE a.tenant_id=tenant AND (a.id=(formal_doc->>'authorizationId')::uuid OR a.profile_hash=formal_digest
  OR a.approval_reference=formal_doc->>'approvalReference' OR ((formal_doc->>'modelAllowed')::boolean AND a.model_approval_reference=formal_doc->>'modelApprovalReference')))
 THEN RAISE EXCEPTION 'BUDGET_TRANSITION_FRESH_FORMAL_REQUIRED';END IF;
 INSERT INTO public.budget_policy_transitions(tenant_id,id,owner_id,source_trial_profile_hash,previous_policy_hash,next_policy_hash,previous_policy_version,previous_policy,next_policy,request_document,request_hash,formal_authorization_id,formal_profile_hash,review_reference,operator_role)
 VALUES(tenant,transition_id,actor,slot.profile_hash,old.policy_hash,policy_digest,old.version,to_jsonb(old),next_doc,req,request_digest,(formal_doc->>'authorizationId')::uuid,formal_digest,req->>'reviewReference',current_user);
 UPDATE public.budget_policies SET policy_hash=policy_digest,document=next_doc,valid_until=(next_doc->>'validUntil')::timestamptz,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=tenant;
 result:=public.oa_formal_authorize(p_formal,slot.profile_hash,formal_doc->>'approvalReference');
 RETURN result||jsonb_build_object('transitionId',transition_id,'policyHash',policy_digest);
END $$;
REVOKE ALL ON FUNCTION public.oa_budget_transition_authorize(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_budget_transition_authorize(text,text,text) TO oa_migrator;
