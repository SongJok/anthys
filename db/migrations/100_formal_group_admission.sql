-- A new independently approved single GROUP target never rewrites the CLOSED
-- trial or broadens the v1 original-DM authorization. This migration installs no
-- authorization, budget, grant, contract, runtime configuration or sender.
ALTER FUNCTION public.oa_formal_authorize(text,text,text) RENAME TO oa_formal_authorize_v84;
REVOKE ALL ON FUNCTION public.oa_formal_authorize_v84(text,text,text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_formal_group_authorize(p_document text,p_expected_trial_hash text,p_approval_ref text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE doc jsonb;slot public.one_shot_trials;subject public.users;existing public.formal_authorizations;tenant uuid;actor uuid;auth_id uuid;digest text;first_at timestamptz;last_at timestamptz;
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'FORMAL_MIGRATOR_REQUIRED';END IF;
 IF octet_length(p_document)>131072 THEN RAISE EXCEPTION 'FORMAL_PROFILE_SIZE_LIMIT';END IF;
 doc:=p_document::jsonb;
 IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR jsonb_typeof(doc->'schemaVersion') IS DISTINCT FROM 'number' OR doc->>'schemaVersion'<>'2' OR (SELECT count(*) FROM jsonb_object_keys(doc))<>20
  OR NOT doc ?& ARRAY['schemaVersion','authorizationId','tenantId','actorId','sourceTrialProfileHash','corpId','externalUserId','robotCode','conversationId','validFrom','validUntil','budgetPolicyHash','approvalReference','modelAllowed','modelApprovalReference','entrypoints','inputPolicy','capabilities','kind','group']
 THEN RAISE EXCEPTION 'FORMAL_PROFILE_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['authorizationId','tenantId','actorId','sourceTrialProfileHash','corpId','externalUserId','robotCode','conversationId','validFrom','validUntil','budgetPolicyHash','approvalReference']) k WHERE jsonb_typeof(doc->k) IS DISTINCT FROM 'string' OR length(doc->>k)=0) THEN RAISE EXCEPTION 'FORMAL_PROFILE_FIELD_TYPE_INVALID';END IF;
 IF doc->>'sourceTrialProfileHash' !~ '^[a-f0-9]{64}$' OR doc->>'budgetPolicyHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'FORMAL_PROFILE_BINDING_HASH_INVALID';END IF;
 tenant:=(doc->>'tenantId')::uuid;actor:=(doc->>'actorId')::uuid;auth_id:=(doc->>'authorizationId')::uuid;
 digest:=encode(sha256(convert_to(p_document,'UTF8')),'hex');first_at:=(doc->>'validFrom')::timestamptz;last_at:=(doc->>'validUntil')::timestamptz;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=tenant FOR UPDATE;
 IF NOT FOUND OR slot.state<>'CLOSED' OR slot.owner_id<>actor OR slot.profile_hash IS DISTINCT FROM p_expected_trial_hash OR slot.profile_hash IS DISTINCT FROM doc->>'sourceTrialProfileHash'
  OR (slot.corp_id,slot.external_user_id,slot.robot_code) IS DISTINCT FROM(doc->>'corpId',doc->>'externalUserId',doc->>'robotCode')
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

 IF doc->>'kind' IS DISTINCT FROM 'FORMAL_GROUP_MENTION_ENTERPRISE' OR last_at-first_at>interval '30 minutes'
 OR doc->'modelAllowed' IS DISTINCT FROM 'true'::jsonb OR doc->'inputPolicy' IS DISTINCT FROM '{"attachments":false,"controls":false}'::jsonb
 OR jsonb_array_length(doc->'entrypoints')<>4 OR NOT (doc->'entrypoints') ?& ARRAY['INGRESS','WORKER','NOTIFIER','API']
 OR jsonb_array_length(doc->'capabilities')<>2
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'capabilities') cap WHERE cap->>'id'='company.agent.ask' AND cap->>'version'='1.0.0')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'capabilities') cap WHERE cap->>'id'='dws.group.audience' AND cap->>'version'='1.0.0')
 THEN RAISE EXCEPTION 'FORMAL_GROUP_FINITE_READ_ONLY_SCOPE_REQUIRED';END IF;
 IF jsonb_typeof(doc->'group') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(doc->'group'))<>14
 OR NOT (doc->'group') ?& ARRAY['mode','contractId','contractVersion','contractHash','scopeId','scopeVersion','membershipHash','directoryHash','enterprisePolicyHash','enterpriseResource','questionHash','audienceReviewReference','sharingReviewReference','allowStop']
 OR doc->'group'->>'mode' IS DISTINCT FROM 'MENTION_ONLY' OR doc->'group'->'allowStop' IS DISTINCT FROM 'true'::jsonb
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['contractHash','membershipHash','directoryHash','enterprisePolicyHash','questionHash']) key WHERE jsonb_typeof(doc->'group'->key) IS DISTINCT FROM 'string' OR doc->'group'->>key !~ '^[a-f0-9]{64}$')
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['contractId','scopeId','enterpriseResource','audienceReviewReference','sharingReviewReference']) key WHERE jsonb_typeof(doc->'group'->key) IS DISTINCT FROM 'string')
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['contractVersion','scopeVersion']) key WHERE jsonb_typeof(doc->'group'->key) IS DISTINCT FROM 'number' OR doc->'group'->>key !~ '^[1-9][0-9]{0,15}$')
 OR doc->'group'->>'enterpriseResource' !~ '^enterprise-agent:[a-fA-F0-9-]{36}$'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['audienceReviewReference','sharingReviewReference']) key WHERE length(doc->'group'->>key)>512 OR doc->'group'->>key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$')
 OR (SELECT count(DISTINCT x) FROM unnest(ARRAY[doc->>'approvalReference',doc->>'modelApprovalReference',doc->'group'->>'audienceReviewReference',doc->'group'->>'sharingReviewReference']) x)<>4
 THEN RAISE EXCEPTION 'FORMAL_GROUP_INDEPENDENT_TARGET_REVIEW_REQUIRED';END IF;
 PERFORM set_config('app.tenant_id',tenant::text,true),set_config('app.actor_id',actor::text,true);
 IF NOT EXISTS(SELECT 1 FROM public.group_contracts c JOIN public.group_contract_delegations d ON d.tenant_id=c.tenant_id AND d.id=c.delegation_id
  JOIN public.dws_group_scopes s ON s.tenant_id=d.tenant_id AND s.id=d.scope_id AND s.owner_id=d.service_owner_id
  JOIN public.dws_identities i ON i.tenant_id=d.tenant_id AND i.id=d.service_identity_id AND i.owner_id=d.service_owner_id
  WHERE c.tenant_id=tenant AND c.id=(doc->'group'->>'contractId')::uuid AND c.group_id=doc->>'conversationId'
  AND c.version=(doc->'group'->>'contractVersion')::bigint AND c.document_hash=doc->'group'->>'contractHash'
  AND c.state='ACTIVE' AND c.valid_from<=clock_timestamp() AND c.expires_at>=last_at AND d.service_owner_id=actor
  AND c.allowed_actions ? 'question.answer' AND NOT c.prohibited_actions ? 'question.answer'
  AND s.id=(doc->'group'->>'scopeId')::uuid AND s.version=(doc->'group'->>'scopeVersion')::bigint
  AND s.expires_at>=last_at AND d.valid_until>=last_at AND i.delegation_expires_at>=last_at AND i.model_egress_allowed
  AND public.oa_group_delegation_live(d.id)) THEN RAISE EXCEPTION 'FORMAL_GROUP_CURRENT_CONTRACT_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'capabilities') cap WHERE NOT EXISTS(SELECT 1 FROM public.capability_bindings b
  WHERE b.tenant_id=tenant AND b.logical_id=cap->>'id' AND b.semantic_version=cap->>'version' AND b.schema_hash=cap->>'bindingHash' AND b.risk='READ' AND b.state='READY'))
 OR NOT EXISTS(SELECT 1 FROM public.resource_grants g WHERE g.tenant_id=tenant AND g.actor_id=actor AND g.capability_id='dws.group.audience'
  AND g.resource_id='dingtalk:group:'||(doc->>'conversationId') AND g.audience_kind='PRIVATE_USER' AND g.audience_id=actor::text AND g.revoked_at IS NULL AND g.expires_at>=last_at)
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['PRIVATE_USER','GROUP']) kind WHERE NOT EXISTS(SELECT 1 FROM public.resource_grants g
  WHERE g.tenant_id=tenant AND g.actor_id=actor AND g.capability_id='company.agent.ask' AND g.resource_id=doc->'group'->>'enterpriseResource'
  AND g.audience_kind=kind AND g.audience_id=CASE WHEN kind='GROUP' THEN doc->>'conversationId' ELSE actor::text END
  AND (kind<>'GROUP' OR g.membership_version=(doc->'group'->>'scopeVersion')::bigint)
  AND g.classification_ceiling IN ('INTERNAL','CONFIDENTIAL','RESTRICTED') AND g.revoked_at IS NULL AND g.expires_at>=last_at))
 THEN RAISE EXCEPTION 'FORMAL_GROUP_CURRENT_READ_BINDINGS_AND_DUAL_GRANTS_REQUIRED';END IF;
 SELECT * INTO existing FROM public.formal_authorizations WHERE tenant_id=tenant AND id=auth_id FOR UPDATE;
 IF FOUND THEN IF existing.profile_hash=digest AND existing.state='AUTHORIZED' THEN RETURN jsonb_build_object('id',auth_id,'state','AUTHORIZED','replayed',true,'profileHash',digest);END IF;RAISE EXCEPTION 'FORMAL_AUTHORIZATION_ID_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=tenant AND owner_id=actor AND state='AUTHORIZED') THEN RAISE EXCEPTION 'FORMAL_AUTHORIZATION_ALREADY_EXISTS';END IF;
 INSERT INTO public.formal_authorizations(tenant_id,id,owner_id,source_trial_profile_hash,source_trial_snapshot_hash,profile_hash,profile_document,auth_epoch,budget_policy_hash,valid_from,valid_until,approval_reference,model_allowed,model_approval_reference)
 VALUES(tenant,auth_id,actor,slot.profile_hash,encode(sha256(convert_to(to_jsonb(slot)::text,'UTF8')),'hex'),digest,doc,subject.auth_epoch,doc->>'budgetPolicyHash',first_at,last_at,p_approval_ref,(doc->>'modelAllowed')::boolean,doc->>'modelApprovalReference');
 INSERT INTO public.formal_lifecycle_events(tenant_id,owner_id,authorization_id,operation,profile_hash,approval_reference,operator_role) VALUES(tenant,actor,auth_id,'AUTHORIZE',digest,p_approval_ref,current_user);
 RETURN jsonb_build_object('id',auth_id,'state','AUTHORIZED','replayed',false,'profileHash',digest);
END $$;

REVOKE ALL ON FUNCTION public.oa_formal_group_authorize(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_formal_group_authorize(text,text,text) TO oa_migrator;

CREATE FUNCTION public.oa_formal_authorize(p_document text,p_expected_trial_hash text,p_approval_ref text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'FORMAL_MIGRATOR_REQUIRED';END IF;
 IF p_document IS NULL OR octet_length(p_document)>131072 THEN RAISE EXCEPTION 'FORMAL_PROFILE_SIZE_LIMIT';END IF;
 IF p_document::jsonb->'schemaVersion'='2'::jsonb THEN RETURN public.oa_formal_group_authorize(p_document,p_expected_trial_hash,p_approval_ref);END IF;
 RETURN public.oa_formal_authorize_v84(p_document,p_expected_trial_hash,p_approval_ref);
END $$;
REVOKE ALL ON FUNCTION public.oa_formal_authorize(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_formal_authorize(text,text,text) TO oa_migrator;

CREATE OR REPLACE FUNCTION public.oa_formal_state(p_service text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE attestation text;tenant uuid;actor uuid;slot public.one_shot_trials;auth public.formal_authorizations;reason text;result jsonb;
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
 result:=jsonb_build_object('mode','FORMAL','restricted',true,'allowed',reason IS NULL,'reason',reason,'authorizationId',auth.id,'tenantId',tenant,'actorId',actor,'corpId',slot.corp_id,'robotCode',slot.robot_code,'conversationId',slot.conversation_id,'budgetPolicyHash',auth.budget_policy_hash,'modelAllowed',auth.model_allowed,'capabilities',auth.profile_document->'capabilities','inputPolicy',auth.profile_document->'inputPolicy','admissionCutoffMs',ceil(extract(epoch FROM greatest(auth.valid_from,auth.created_at))*1000)::bigint,'deadline',auth.valid_until);
 IF auth.profile_document->'schemaVersion'='2'::jsonb THEN result:=result||jsonb_build_object('channel','GROUP','conversationId',auth.profile_document->>'conversationId','group',auth.profile_document->'group');END IF;
 RETURN result;
END $$;

ALTER TABLE public.formal_admissions ADD COLUMN channel text CHECK(channel IS NULL OR channel='GROUP');
ALTER TABLE public.formal_admissions ADD COLUMN input_hash text CHECK(input_hash IS NULL OR input_hash~'^[a-f0-9]{64}$');
ALTER TABLE public.formal_admissions ADD COLUMN control_kind text CHECK(control_kind IS NULL OR control_kind IN ('NONE','STOP'));
ALTER TABLE public.formal_admissions ADD CHECK(channel IS NULL OR input_hash IS NOT NULL AND control_kind IS NOT NULL);

-- The runtime can still call the legacy signature directly. Explicitly reject
-- group v2 there; routing through the new overload is not an access boundary.
ALTER FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) RENAME TO oa_lifecycle_admit_v71;
REVOKE ALL ON FUNCTION public.oa_lifecycle_admit_v71(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_lifecycle_admit(p_corp text,p_employee text,p_robot text,p_conversation text,p_msg text,p_trial_eligible boolean,p_task uuid,p_run uuid,p_created_ms bigint,p_channel text,p_attachments boolean,p_control boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE formal jsonb;
BEGIN
 formal:=public.oa_formal_state('INGRESS');
 IF formal->>'channel'='GROUP' THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_GROUP_HASH_BOUND_ENTRY_REQUIRED');END IF;
 RETURN public.oa_lifecycle_admit_v71(p_corp,p_employee,p_robot,p_conversation,p_msg,p_trial_eligible,p_task,p_run,p_created_ms,p_channel,p_attachments,p_control);
END $$;
REVOKE ALL ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean) TO oa_runtime;

-- The old twelve-argument boundary retains its exact original-DM semantics.
-- Only the new call carries the trusted goal hash and parsed control kind.
CREATE FUNCTION public.oa_lifecycle_admit(p_corp text,p_employee text,p_robot text,p_conversation text,p_msg text,p_trial_eligible boolean,p_task uuid,p_run uuid,p_created_ms bigint,p_channel text,p_attachments boolean,p_control boolean,p_input_hash text,p_control_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE formal jsonb;slot public.one_shot_trials;auth public.formal_authorizations;receipt public.formal_admissions;tenant uuid;actor uuid;existing_task uuid;
BEGIN
 formal:=public.oa_formal_state('INGRESS');
 IF formal IS NULL OR formal->>'channel' IS DISTINCT FROM 'GROUP' THEN
  RETURN public.oa_lifecycle_admit(p_corp,p_employee,p_robot,p_conversation,p_msg,p_trial_eligible,p_task,p_run,p_created_ms,p_channel,p_attachments,p_control);
 END IF;
 tenant:=nullif(current_setting('app.tenant_id',true),'')::uuid;actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
 SELECT * INTO slot FROM public.one_shot_trials WHERE tenant_id=tenant FOR UPDATE;
 SELECT * INTO auth FROM public.formal_authorizations WHERE tenant_id=tenant AND id=(formal->>'authorizationId')::uuid AND owner_id=actor FOR UPDATE;
 IF slot.owner_id IS DISTINCT FROM actor OR slot.state IS DISTINCT FROM 'CLOSED' OR auth.id IS NULL
 OR (slot.corp_id,slot.external_user_id,slot.robot_code) IS DISTINCT FROM(p_corp,p_employee,p_robot)
 OR p_conversation IS DISTINCT FROM auth.profile_document->>'conversationId' OR p_channel IS DISTINCT FROM 'GROUP'
 THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_GROUP_MESSAGE_BINDING_MISMATCH');END IF;
 IF slot.msg_id=p_msg THEN RETURN formal||jsonb_build_object('allowed',false,'duplicate',true,'taskId',slot.task_id,'reason','CLOSED_TRIAL_MESSAGE_ACK_ONLY');END IF;
 SELECT * INTO receipt FROM public.formal_admissions WHERE tenant_id=tenant AND owner_id=actor AND msg_id=p_msg;
 IF FOUND THEN RETURN formal||jsonb_build_object('allowed',false,'duplicate',true,'taskId',receipt.task_id,'reason','FORMAL_MESSAGE_ACK_ONLY');END IF;
 IF EXISTS(SELECT 1 FROM public.event_inbox e WHERE e.tenant_id=tenant AND e.owner_id=actor AND e.source='DINGTALK' AND e.event_key=p_robot||':'||p_conversation||':'||p_msg) THEN
  SELECT t.id INTO existing_task FROM public.tasks t JOIN public.event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id WHERE t.tenant_id=tenant AND t.requester_id=actor AND e.event_key=p_robot||':'||p_conversation||':'||p_msg;
  RETURN formal||jsonb_build_object('allowed',false,'duplicate',true,'taskId',existing_task,'reason','OLD_INBOX_ACK_ONLY');
 END IF;
 IF NOT coalesce((formal->>'allowed')::boolean,false) THEN RETURN formal;END IF;
 IF p_created_ms IS NULL OR p_created_ms<=0 OR p_created_ms>9007199254740991 THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_EVENT_TIMESTAMP_REQUIRED');END IF;
 IF p_created_ms<(formal->>'admissionCutoffMs')::bigint THEN RETURN formal||jsonb_build_object('allowed',false,'reason','PRE_FORMAL_EVENT_REJECTED');END IF;
 IF p_created_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint+5000 OR p_created_ms>=floor(extract(epoch FROM auth.valid_until)*1000)::bigint THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_EVENT_TIMESTAMP_FUTURE');END IF;
 IF p_attachments IS DISTINCT FROM false OR p_control IS NULL OR p_input_hash IS NULL OR p_input_hash !~ '^[a-f0-9]{64}$'
 OR p_control_kind IS NULL OR p_control_kind NOT IN ('NONE','STOP') OR p_control IS DISTINCT FROM(p_control_kind='STOP')
 OR p_control_kind='NONE' AND p_input_hash IS DISTINCT FROM auth.profile_document->'group'->>'questionHash'
 OR p_control_kind='STOP' AND auth.profile_document->'group'->'allowStop' IS DISTINCT FROM 'true'::jsonb
 THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_GROUP_INPUT_NOT_APPROVED');END IF;
 IF p_msg IS NULL OR length(p_msg) NOT BETWEEN 1 AND 1024 OR p_task IS NULL OR p_run IS NULL OR p_task=slot.task_id OR p_run=slot.run_id
 OR EXISTS(SELECT 1 FROM public.tasks WHERE tenant_id=tenant AND id=p_task) OR EXISTS(SELECT 1 FROM public.runs WHERE tenant_id=tenant AND id=p_run)
 THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_FRESH_BINDING_REQUIRED');END IF;
 IF p_control_kind='NONE' AND EXISTS(SELECT 1 FROM public.formal_admissions WHERE tenant_id=tenant AND authorization_id=auth.id AND channel='GROUP' AND control_kind='NONE')
 THEN RETURN formal||jsonb_build_object('allowed',false,'reason','FORMAL_GROUP_QUESTION_LIMIT');END IF;
 INSERT INTO public.formal_admissions(tenant_id,owner_id,authorization_id,msg_id,conversation_id,event_created_ms,candidate_task_id,candidate_run_id,channel,input_hash,control_kind)
 VALUES(tenant,actor,auth.id,p_msg,p_conversation,p_created_ms,p_task,p_run,'GROUP',p_input_hash,p_control_kind);
 RETURN formal||jsonb_build_object('allowed',true,'duplicate',false,'taskId',p_task,'runId',p_run,'msgId',p_msg);
END $$;
REVOKE ALL ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_lifecycle_admit(text,text,text,text,text,boolean,uuid,uuid,bigint,text,boolean,boolean,text,text) TO oa_runtime;

CREATE FUNCTION public.oa_formal_group_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.formal_admissions;ok boolean;
BEGIN
 SELECT * INTO a FROM public.formal_admissions WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 IF a.channel IS DISTINCT FROM 'GROUP' THEN
  IF EXISTS(SELECT 1 FROM public.formal_authorizations auth WHERE auth.tenant_id=a.tenant_id AND auth.id=a.authorization_id AND auth.profile_document->'schemaVersion'='2'::jsonb) THEN RAISE EXCEPTION 'FORMAL_GROUP_HASH_BOUND_ENTRY_REQUIRED';END IF;
  RETURN NEW;
 END IF;
 SELECT EXISTS(SELECT 1 FROM public.formal_authorizations auth
 JOIN public.tasks t ON t.tenant_id=auth.tenant_id AND t.id=a.candidate_task_id AND t.requester_id=a.owner_id
 JOIN public.runs r ON r.tenant_id=t.tenant_id AND r.id=a.candidate_run_id AND r.task_id=t.id AND r.owner_id=t.requester_id
 JOIN public.event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id AND e.owner_id=t.requester_id AND e.source='DINGTALK'
 JOIN public.conversations v ON v.tenant_id=t.tenant_id AND v.id=t.conversation_id AND v.kind='GROUP' AND v.source_mode='MENTION_ONLY'
 JOIN public.one_shot_trials slot ON slot.tenant_id=auth.tenant_id AND slot.owner_id=auth.owner_id AND slot.state='CLOSED'
 WHERE auth.tenant_id=a.tenant_id AND auth.id=a.authorization_id AND auth.owner_id=a.owner_id AND auth.profile_document->'schemaVersion'='2'::jsonb
 AND a.task_id=t.id AND a.run_id=r.id AND a.conversation_id=auth.profile_document->>'conversationId' AND v.external_id=a.conversation_id
 AND e.event_key=slot.robot_code||':'||a.conversation_id||':'||a.msg_id AND t.created_at>=auth.created_at AND r.created_at>=auth.created_at AND e.created_at>=auth.created_at
 AND t.audience=jsonb_build_object('kind','GROUP','targetId',a.conversation_id,'classificationCeiling','INTERNAL')
 AND encode(sha256(convert_to(t.goal,'UTF8')),'hex')=a.input_hash
 AND (a.control_kind='NONE' AND t.control_kind IS NULL AND a.input_hash=auth.profile_document->'group'->>'questionHash' AND (r.budget->>'maxTurns')::int<=4
 OR a.control_kind='STOP' AND t.control_kind='STOP' AND (r.budget->>'maxTurns')::int=0 AND (r.budget->>'maxTools')::int=0)) INTO ok;
 IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FORMAL_GROUP_ADMISSION_BINDING_MISMATCH';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.oa_formal_group_binding_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER formal_group_admission_binding AFTER INSERT OR UPDATE ON public.formal_admissions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.oa_formal_group_binding_guard();
