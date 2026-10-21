-- Explicit H5 single-case escalation only. No existing contract, roster policy,
-- grant, credential, scheduler, authorization or external delivery is activated.
ALTER FUNCTION public.oa_group_case_authority(text,uuid,text,bigint) RENAME TO oa_group_case_authority_v87;
REVOKE ALL ON FUNCTION public.oa_group_case_authority_v87(text,uuid,text,bigint) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_group_case_authority(p_group text,p_session uuid,p_action text,p_version bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE authority jsonb;c public.group_contracts;
BEGIN
 IF p_action IS DISTINCT FROM 'case.escalate' THEN RETURN public.oa_group_case_authority_v87(p_group,p_session,p_action,p_version);END IF;
 -- Reading is an additional prerequisite, never the escalation permission.
 -- The legacy function retains its exact CLOSED/formal/session/member barriers.
 authority:=public.oa_group_case_authority_v87(p_group,p_session,'case.read',p_version);
 SELECT * INTO c FROM public.group_contracts WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=(authority->>'contractId')::uuid AND group_id=p_group;
 IF authority->'administrator' IS DISTINCT FROM 'true'::jsonb OR c.id IS NULL
 OR NOT c.allowed_actions ? 'case.escalate' OR c.prohibited_actions ? 'case.escalate'
 THEN RAISE EXCEPTION 'GROUP_ESCALATION_DENIED';END IF;
 RETURN authority;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_case_authority(text,uuid,text,bigint) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_case_authority(text,uuid,text,bigint) TO oa_runtime;

CREATE TABLE public.group_case_escalations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,group_id text NOT NULL,administrator_id uuid NOT NULL,service_owner_id uuid NOT NULL,
 session_id uuid NOT NULL,auth_epoch bigint NOT NULL,case_id uuid NOT NULL,case_version bigint NOT NULL,case_payload_hash text NOT NULL CHECK(case_payload_hash~'^[a-f0-9]{64}$'),
 contract_id uuid NOT NULL,contract_version bigint NOT NULL,contract_hash text NOT NULL,
 request_id uuid NOT NULL,intent_hash text NOT NULL,context_hash text NOT NULL,preview_hash text NOT NULL,
 source_hash text NOT NULL,proof_ref jsonb NOT NULL,expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED','QUEUED','CLAIMED','CANCELLED','SUPPRESSED','APPLIED_UNVERIFIED','FAILED','UNKNOWN')),
 reserved_at timestamptz,claim_id uuid,claimed_at timestamptz,task_id uuid,run_id uuid,delivery_id uuid,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,administrator_id,request_id),
 UNIQUE(tenant_id,group_id,case_id,case_version,contract_id,contract_version),
 FOREIGN KEY(tenant_id,case_id,group_id) REFERENCES public.group_cases(tenant_id,id,group_id),
 FOREIGN KEY(tenant_id,administrator_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,service_owner_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES public.sessions(tenant_id,id),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES public.group_contracts(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES public.tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES public.runs(tenant_id,id),
 FOREIGN KEY(tenant_id,delivery_id) REFERENCES public.deliveries(tenant_id,id),
 CHECK(case_version>0 AND contract_version>0 AND auth_epoch>0),
 CHECK(intent_hash~'^[a-f0-9]{64}$' AND context_hash~'^[a-f0-9]{64}$' AND preview_hash~'^[a-f0-9]{64}$' AND source_hash~'^[a-f0-9]{64}$' AND contract_hash~'^[a-f0-9]{64}$'),
 CHECK(jsonb_typeof(proof_ref)='object'),CHECK((claim_id IS NULL)=(claimed_at IS NULL)),
 CHECK((task_id IS NULL)=(run_id IS NULL) AND (run_id IS NULL)=(delivery_id IS NULL))
);
ALTER TABLE public.group_case_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_case_escalations FORCE ROW LEVEL SECURITY;
CREATE POLICY escalation_subject ON public.group_case_escalations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND (administrator_id=nullif(current_setting('app.actor_id',true),'')::uuid OR service_owner_id=nullif(current_setting('app.actor_id',true),'')::uuid));
GRANT SELECT ON public.group_case_escalations TO oa_runtime;
CREATE INDEX group_case_escalation_queue ON public.group_case_escalations(tenant_id,service_owner_id,state,expires_at,id);

CREATE FUNCTION public.oa_group_escalation_prepare(p_group text,p_session uuid,p_id uuid,p_request uuid,p_intent text,p_context text,p_case uuid,p_case_version bigint,p_contract_version bigint,p_preview text,p_source text,p_proof jsonb,p_expires timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 a jsonb;c public.group_cases;contract public.group_contracts;delegation public.group_contract_delegations;e public.group_case_escalations;epoch bigint;
BEGIN
 IF p_id IS NULL OR p_request IS NULL OR p_case IS NULL OR p_case_version IS NULL OR p_case_version<1 OR p_contract_version IS NULL OR p_contract_version<1
 OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_context IS NULL OR p_context !~ '^[a-f0-9]{64}$'
 OR p_preview IS NULL OR p_preview !~ '^[a-f0-9]{64}$' OR p_source IS NULL OR p_source !~ '^[a-f0-9]{64}$'
 OR p_proof IS NULL OR jsonb_typeof(p_proof)<>'object' OR octet_length(p_proof::text)>262144
 OR p_expires IS NULL OR NOT isfinite(p_expires) OR p_expires<=clock_timestamp() OR p_expires>clock_timestamp()+interval '60 seconds'
 THEN RAISE EXCEPTION 'GROUP_ESCALATION_INPUT_INVALID';END IF;
 a:=public.oa_group_case_authority(p_group,p_session,'case.escalate',p_contract_version);
 SELECT * INTO c FROM public.group_cases WHERE tenant_id=tenant AND id=p_case AND group_id=p_group AND contract_id=(a->>'contractId')::uuid FOR SHARE;
 IF NOT FOUND OR c.version<>p_case_version OR c.state NOT IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED') THEN RAISE EXCEPTION 'GROUP_ESCALATION_SOURCE_CHANGED';END IF;
 SELECT * INTO contract FROM public.group_contracts WHERE tenant_id=tenant AND id=c.contract_id;
 SELECT * INTO delegation FROM public.group_contract_delegations WHERE tenant_id=tenant AND id=contract.delegation_id;
 SELECT auth_epoch INTO epoch FROM public.sessions WHERE tenant_id=tenant AND id=p_session AND owner_id=actor;
 IF p_expires>contract.expires_at OR p_expires>delegation.valid_until THEN RAISE EXCEPTION 'GROUP_ESCALATION_EXPIRED';END IF;
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND administrator_id=actor AND request_id=p_request;
 IF NOT FOUND THEN SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND group_id=p_group AND case_id=p_case AND case_version=p_case_version AND contract_id=c.contract_id AND contract_version=p_contract_version;END IF;
 IF FOUND THEN
  IF e.administrator_id<>actor OR e.session_id<>p_session OR e.intent_hash<>p_intent OR e.context_hash<>p_context OR e.group_id<>p_group OR e.case_id<>p_case OR e.case_version<>p_case_version OR e.contract_version<>p_contract_version OR e.source_hash<>p_source THEN RAISE EXCEPTION 'GROUP_ESCALATION_SOURCE_CHANGED';END IF;
  PERFORM public.oa_group_escalation_request(e.id,p_request,'PREPARE',p_intent);
  RETURN to_jsonb(e);
 END IF;
 INSERT INTO public.group_case_escalations(tenant_id,id,group_id,administrator_id,service_owner_id,session_id,auth_epoch,case_id,case_version,case_payload_hash,contract_id,contract_version,contract_hash,request_id,intent_hash,context_hash,preview_hash,source_hash,proof_ref,expires_at)
 VALUES(tenant,p_id,p_group,actor,delegation.service_owner_id,p_session,epoch,p_case,p_case_version,c.payload_hash,c.contract_id,p_contract_version,contract.document_hash,p_request,p_intent,p_context,p_preview,p_source,p_proof,p_expires) RETURNING * INTO e;
 PERFORM public.oa_group_escalation_request(e.id,p_request,'PREPARE',p_intent);
 RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_prepare(text,uuid,uuid,uuid,text,text,uuid,bigint,bigint,text,text,jsonb,timestamptz) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_prepare(text,uuid,uuid,uuid,text,text,uuid,bigint,bigint,text,text,jsonb,timestamptz) TO oa_runtime;

CREATE TABLE public.group_case_escalation_requests (
 tenant_id uuid NOT NULL,actor_id uuid NOT NULL,id uuid NOT NULL,proposal_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('PREPARE','ENQUEUE','CANCEL')),intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,actor_id,id),FOREIGN KEY(tenant_id,proposal_id) REFERENCES public.group_case_escalations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.group_case_escalation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_case_escalation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY escalation_request_owner ON public.group_case_escalation_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE TRIGGER escalation_request_immutable BEFORE UPDATE OR DELETE ON public.group_case_escalation_requests FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
CREATE FUNCTION public.oa_group_escalation_request(p_id uuid,p_key uuid,p_operation text,p_intent text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;r public.group_case_escalation_requests;
BEGIN
 IF p_key IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_operation NOT IN ('PREPARE','ENQUEUE','CANCEL') THEN RAISE EXCEPTION 'GROUP_ESCALATION_INPUT_INVALID';END IF;
 SELECT * INTO r FROM public.group_case_escalation_requests WHERE tenant_id=tenant AND actor_id=actor AND id=p_key;
 IF FOUND THEN
  IF (r.proposal_id,r.operation,r.intent_hash) IS DISTINCT FROM (p_id,p_operation,p_intent) THEN RAISE EXCEPTION 'GROUP_ESCALATION_SOURCE_CHANGED';END IF;
 ELSE INSERT INTO public.group_case_escalation_requests(tenant_id,actor_id,id,proposal_id,operation,intent_hash) VALUES(tenant,actor,p_key,p_id,p_operation,p_intent);END IF;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_request(uuid,uuid,text,text) FROM PUBLIC,oa_app,oa_runtime,oa_queue;

CREATE FUNCTION public.oa_group_escalation_confirm(p_group text,p_session uuid,p_id uuid,p_preview text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;e public.group_case_escalations;a jsonb;c public.group_cases;
BEGIN
 -- Discover only this caller's reference; authority then takes the contract
 -- lock before row/quota locks, consistently with current reminder staging.
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND id=p_id AND group_id=p_group AND administrator_id=actor AND session_id=p_session;
 IF NOT FOUND OR e.preview_hash IS DISTINCT FROM p_preview THEN RAISE EXCEPTION 'GROUP_ESCALATION_NOT_FOUND';END IF;
 a:=public.oa_group_case_authority(p_group,p_session,'case.escalate',e.contract_version);
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND id=p_id FOR UPDATE;
 PERFORM public.oa_group_escalation_request(p_id,p_request,'ENQUEUE',p_preview);
 IF e.state<>'PREPARED' THEN RETURN to_jsonb(e)||jsonb_build_object('replayed',true);END IF;
 IF e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'GROUP_ESCALATION_EXPIRED';END IF;
 SELECT * INTO c FROM public.group_cases WHERE tenant_id=tenant AND id=e.case_id AND group_id=p_group FOR SHARE;
 IF c.id IS NULL OR c.version<>e.case_version OR c.state NOT IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED')
 OR NOT EXISTS(SELECT 1 FROM public.group_contracts g WHERE g.tenant_id=tenant AND g.id=e.contract_id AND g.document_hash=e.contract_hash)
 THEN RAISE EXCEPTION 'GROUP_ESCALATION_SOURCE_CHANGED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-reminder-quota:'||p_group,0));
 -- Independent restrictive ceiling: one escalation for this case/24h and one
 -- group notification/hour, including other owners, versions and UNKNOWNs.
 IF EXISTS(SELECT 1 FROM public.group_case_escalations x WHERE x.tenant_id=tenant AND x.group_id=p_group AND x.id<>p_id AND x.reserved_at IS NOT NULL
  AND (x.state IN ('CLAIMED','UNKNOWN') OR x.state='QUEUED' AND x.expires_at>clock_timestamp() OR x.reserved_at>clock_timestamp()-interval '1 hour' OR x.case_id=e.case_id AND x.reserved_at>clock_timestamp()-interval '24 hours'))
 OR EXISTS(SELECT 1 FROM public.group_reminder_notifications n JOIN public.deliveries d ON d.tenant_id=n.tenant_id AND d.id=n.delivery_id
  WHERE n.tenant_id=tenant AND n.group_id=p_group AND (d.state IN ('PENDING','SENDING','UNKNOWN') OR greatest(n.reserved_at,d.sending_at)>clock_timestamp()-interval '1 hour'))
 THEN RAISE EXCEPTION 'GROUP_ESCALATION_LIMIT';END IF;
 UPDATE public.group_case_escalations SET state='QUEUED',reserved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=tenant AND id=p_id RETURNING * INTO e;
 RETURN to_jsonb(e)||jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_confirm(text,uuid,uuid,text,uuid) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_confirm(text,uuid,uuid,text,uuid) TO oa_runtime;

CREATE FUNCTION public.oa_group_escalation_cancel(p_group text,p_session uuid,p_id uuid,p_preview text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;e public.group_case_escalations;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=s.tenant_id
 WHERE s.tenant_id=tenant AND s.id=p_session AND s.owner_id=actor AND s.auth_epoch=u.auth_epoch AND u.status='ACTIVE' AND t.status='ACTIVE' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'GROUP_ESCALATION_DENIED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||p_group,0));
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND id=p_id AND group_id=p_group AND administrator_id=actor AND session_id=p_session FOR UPDATE;
 IF NOT FOUND OR e.preview_hash IS DISTINCT FROM p_preview THEN RAISE EXCEPTION 'GROUP_ESCALATION_NOT_FOUND';END IF;
 PERFORM public.oa_group_escalation_request(p_id,p_request,'CANCEL',p_preview);
 -- A stop grants no new read/send authority. Started/uncertain work is never
 -- returned to a claimable state and its reservation is never removed.
 UPDATE public.group_case_escalations SET state=CASE WHEN state IN ('PREPARED','QUEUED') THEN 'CANCELLED' WHEN state='CLAIMED' THEN 'UNKNOWN' ELSE state END,last_error=CASE WHEN state IN ('CLAIMED','UNKNOWN') THEN 'LOCAL_STOP_REMOTE_UNCONFIRMED' ELSE last_error END,updated_at=clock_timestamp()
 WHERE tenant_id=tenant AND id=p_id RETURNING * INTO e;RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_cancel(text,uuid,uuid,text,uuid) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_cancel(text,uuid,uuid,text,uuid) TO oa_runtime;

-- The shared reminder ledger must see these independent notifications too.
-- Callers get it only after the original reminder authority oracle succeeds.
CREATE FUNCTION public.oa_group_escalation_usage(p_group text,p_until timestamptz) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('notificationId',e.id,'at',greatest(e.reserved_at,d.sending_at),'caseIds',jsonb_build_array(e.case_id),
 'state',CASE WHEN e.state='QUEUED' AND e.expires_at<=p_until THEN 'SUPPRESSED' WHEN e.state IN ('QUEUED','CLAIMED') THEN 'PENDING' WHEN e.state='UNKNOWN' OR d.state='UNKNOWN' THEN 'UNKNOWN' WHEN e.state='APPLIED_UNVERIFIED' THEN 'APPLIED_UNVERIFIED' WHEN e.state='FAILED' THEN 'FAILED' ELSE 'SUPPRESSED' END) ORDER BY e.reserved_at,e.id),'[]'::jsonb)
 FROM public.group_case_escalations e LEFT JOIN public.deliveries d ON d.tenant_id=e.tenant_id AND d.id=e.delivery_id
 WHERE e.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND e.group_id=p_group AND e.reserved_at IS NOT NULL
 AND (greatest(e.reserved_at,d.sending_at)>=p_until-interval '48 hours' OR e.state IN ('CLAIMED','UNKNOWN') OR e.state='QUEUED' AND e.expires_at>p_until OR d.state IN ('PENDING','SENDING','UNKNOWN'));
$$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_usage(text,timestamptz) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
ALTER FUNCTION public.oa_group_reminder_usage(uuid,bigint) RENAME TO oa_group_reminder_usage_v95;
REVOKE ALL ON FUNCTION public.oa_group_reminder_usage_v95(uuid,bigint) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_group_reminder_usage(p_occurrence uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=public.oa_group_reminder_usage_v95(p_occurrence,p_fence);
 RETURN jsonb_set(result,'{notifications}',(result->'notifications')||public.oa_group_escalation_usage(result->>'groupId',(result->>'until')::timestamptz));
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_usage(uuid,bigint) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_usage(uuid,bigint) TO oa_runtime;
ALTER FUNCTION public.oa_group_reminder_send_usage(uuid,bigint) RENAME TO oa_group_reminder_send_usage_v96;
REVOKE ALL ON FUNCTION public.oa_group_reminder_send_usage_v96(uuid,bigint) FROM PUBLIC,oa_app,oa_runtime,oa_queue;
CREATE FUNCTION public.oa_group_reminder_send_usage(p_occurrence uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=public.oa_group_reminder_send_usage_v96(p_occurrence,p_fence);
 RETURN jsonb_set(result,'{notifications}',(result->'notifications')||public.oa_group_escalation_usage(result->>'groupId',(result->>'until')::timestamptz));
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_send_usage(uuid,bigint) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_send_usage(uuid,bigint) TO oa_runtime;

CREATE FUNCTION public.oa_group_escalation_case(p_group text,p_session uuid,p_case uuid,p_version bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;result jsonb;
BEGIN
 a:=public.oa_group_case_authority(p_group,p_session,'case.escalate',p_version);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'version',c.version,'state',c.state,'ownerId',c.owner_id,'createdBy',c.created_by,'resourceHash',c.resource_hash,'payloadRef',c.payload_ref,'payloadHash',c.payload_hash,
 'sources',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'key',s.source_key,'eventId',s.source_event_id,'authorId',s.submitted_by,'createdAt',s.created_at,
 'authorActive',u.status='ACTIVE','externalId',u.external_user_id,'corpId',org.corp_id,'cipher',e.payload_cipher_ref,'eventState',e.state,'eventSource',e.source,'eventOwner',e.owner_id,
 'goal',(SELECT t.goal FROM public.tasks t JOIN public.conversations v ON v.tenant_id=t.tenant_id AND v.id=t.conversation_id AND v.kind='GROUP' AND v.external_id=c.group_id WHERE t.tenant_id=tenant AND t.source_event_id=s.source_event_id AND t.requester_id=s.submitted_by ORDER BY t.id LIMIT 1)) ORDER BY s.id),'[]'::jsonb)
 FROM public.group_case_sources s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.submitted_by JOIN public.tenants org ON org.tenant_id=s.tenant_id
 LEFT JOIN public.event_inbox e ON e.tenant_id=s.tenant_id AND e.id=s.source_event_id
 WHERE s.tenant_id=tenant AND s.case_id=c.id AND s.group_id=c.group_id)) ORDER BY c.id),'[]'::jsonb) INTO result
 FROM public.group_cases c WHERE c.tenant_id=tenant AND c.group_id=p_group AND c.id=p_case AND c.contract_id=(a->>'contractId')::uuid;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_case(text,uuid,uuid,bigint) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_case(text,uuid,uuid,bigint) TO oa_runtime;

CREATE FUNCTION public.oa_group_escalation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF ROW(NEW.tenant_id,NEW.id,NEW.group_id,NEW.administrator_id,NEW.service_owner_id,NEW.session_id,NEW.auth_epoch,NEW.case_id,NEW.case_version,NEW.case_payload_hash,NEW.contract_id,NEW.contract_version,NEW.contract_hash,NEW.request_id,NEW.intent_hash,NEW.context_hash,NEW.preview_hash,NEW.source_hash,NEW.proof_ref,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.group_id,OLD.administrator_id,OLD.service_owner_id,OLD.session_id,OLD.auth_epoch,OLD.case_id,OLD.case_version,OLD.case_payload_hash,OLD.contract_id,OLD.contract_version,OLD.contract_hash,OLD.request_id,OLD.intent_hash,OLD.context_hash,OLD.preview_hash,OLD.source_hash,OLD.proof_ref,OLD.expires_at,OLD.created_at)
 THEN RAISE EXCEPTION 'GROUP_ESCALATION_PROVENANCE_IMMUTABLE';END IF;
 IF OLD.reserved_at IS NOT NULL AND NEW.reserved_at IS DISTINCT FROM OLD.reserved_at OR OLD.claim_id IS NOT NULL AND ROW(NEW.claim_id,NEW.claimed_at) IS DISTINCT FROM ROW(OLD.claim_id,OLD.claimed_at)
 OR OLD.delivery_id IS NOT NULL AND ROW(NEW.task_id,NEW.run_id,NEW.delivery_id) IS DISTINCT FROM ROW(OLD.task_id,OLD.run_id,OLD.delivery_id)
 OR OLD.state IS DISTINCT FROM NEW.state AND NOT (OLD.state='PREPARED' AND NEW.state IN ('QUEUED','CANCELLED') OR OLD.state='QUEUED' AND NEW.state IN ('CLAIMED','CANCELLED') OR OLD.state='CLAIMED' AND NEW.state IN ('UNKNOWN','SUPPRESSED','APPLIED_UNVERIFIED','FAILED'))
 THEN RAISE EXCEPTION 'GROUP_ESCALATION_REPLAY_FORBIDDEN';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_immutable() FROM PUBLIC;
CREATE TRIGGER group_case_escalation_immutable BEFORE UPDATE ON public.group_case_escalations FOR EACH ROW EXECUTE FUNCTION public.oa_group_escalation_immutable();

ALTER TABLE public.tasks DROP CONSTRAINT tasks_control_kind_check;
ALTER TABLE public.tasks ADD CHECK(control_kind IN ('STOP','CLARIFICATION_REPLY','PERSONA','MEMORY','REMINDER','SCHEDULE','GROUP_CASE','GROUP_REMINDER','GROUP_ESCALATION'));

CREATE FUNCTION public.oa_group_escalation_live(p_id uuid,p_claim uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.group_case_escalations e
 JOIN public.group_contracts c ON c.tenant_id=e.tenant_id AND c.id=e.contract_id AND c.group_id=e.group_id
 JOIN public.group_contract_delegations d ON d.tenant_id=c.tenant_id AND d.id=c.delegation_id AND d.administrator_id=e.administrator_id AND d.service_owner_id=e.service_owner_id
 JOIN public.sessions s ON s.tenant_id=e.tenant_id AND s.id=e.session_id AND s.owner_id=e.administrator_id
 JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id
 JOIN public.users owner ON owner.tenant_id=e.tenant_id AND owner.id=e.service_owner_id
 JOIN public.tenants org ON org.tenant_id=e.tenant_id
 JOIN public.group_cases item ON item.tenant_id=e.tenant_id AND item.id=e.case_id AND item.group_id=e.group_id AND item.contract_id=e.contract_id
 WHERE e.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND e.id=p_id AND e.claim_id=p_claim
 AND e.service_owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND e.state='CLAIMED' AND e.expires_at>clock_timestamp()
 AND c.version=e.contract_version AND c.document_hash=e.contract_hash AND c.state='ACTIVE' AND c.valid_from<=clock_timestamp() AND c.expires_at>clock_timestamp()
 AND c.allowed_actions ? 'case.escalate' AND NOT c.prohibited_actions ? 'case.escalate' AND c.allowed_actions ? 'case.read' AND NOT c.prohibited_actions ? 'case.read'
 AND s.auth_epoch=e.auth_epoch AND u.auth_epoch=s.auth_epoch AND u.status='ACTIVE' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND owner.status='ACTIVE' AND org.status='ACTIVE' AND public.oa_group_delegation_live(d.id)
 AND item.version=e.case_version AND item.payload_hash=e.case_payload_hash AND item.state IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED')
 AND NOT EXISTS(SELECT 1 FROM public.one_shot_trials t WHERE t.tenant_id=e.tenant_id)
 AND NOT EXISTS(SELECT 1 FROM public.formal_authorizations a WHERE a.tenant_id=e.tenant_id)
 AND nullif(current_setting('app.trial_profile_hash',true),'') IS NULL AND nullif(current_setting('app.formal_profile_hash',true),'') IS NULL);
$$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_live(uuid,uuid) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_live(uuid,uuid) TO oa_runtime;
CREATE FUNCTION public.oa_group_escalation_claim(p_id uuid,p_preview text,p_claim uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;e public.group_case_escalations;
BEGIN
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND id=p_id AND service_owner_id=actor AND preview_hash=p_preview;
 IF NOT FOUND OR p_claim IS NULL THEN RAISE EXCEPTION 'GROUP_ESCALATION_NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||e.group_id,0));
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND id=p_id FOR UPDATE;
 IF e.state<>'QUEUED' THEN RETURN NULL;END IF;
 UPDATE public.group_case_escalations SET state='CLAIMED',claim_id=p_claim,claimed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=tenant AND id=p_id RETURNING * INTO e;
 IF NOT public.oa_group_escalation_live(p_id,p_claim) THEN UPDATE public.group_case_escalations SET state='SUPPRESSED',last_error='CURRENT_AUTHORITY_UNAVAILABLE',updated_at=clock_timestamp() WHERE tenant_id=tenant AND id=p_id RETURNING * INTO e;END IF;
 RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_claim(uuid,text,uuid) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_claim(uuid,text,uuid) TO oa_runtime;

CREATE FUNCTION public.oa_group_escalation_stage(p_id uuid,p_claim uuid,p_task uuid,p_run uuid,p_delivery uuid,p_body text,p_cipher jsonb,p_content_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;e public.group_case_escalations;epoch bigint;target jsonb;
BEGIN
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND id=p_id AND service_owner_id=actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_ESCALATION_NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||e.group_id,0));
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND id=p_id FOR UPDATE;
 IF NOT public.oa_group_escalation_live(p_id,p_claim) OR e.delivery_id IS NOT NULL THEN RAISE EXCEPTION 'GROUP_ESCALATION_SOURCE_CHANGED';END IF;
 IF p_task IS NULL OR p_run IS NULL OR p_delivery IS NULL OR p_body IS NULL OR octet_length(p_body) NOT BETWEEN 1 AND 6000 OR p_content_hash IS DISTINCT FROM encode(sha256(convert_to(p_body,'UTF8')),'hex') OR p_cipher IS NULL OR jsonb_typeof(p_cipher)<>'object' THEN RAISE EXCEPTION 'GROUP_ESCALATION_INPUT_INVALID';END IF;
 SELECT auth_epoch INTO epoch FROM public.users WHERE tenant_id=tenant AND id=actor AND status='ACTIVE';
 target:=jsonb_build_object('kind','GROUP','targetId',e.group_id,'classificationCeiling','INTERNAL');
 INSERT INTO public.tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at,control_kind) VALUES(tenant,p_task,actor,'明确确认的单事项同群升级','COMPLETED',target,epoch,e.expires_at,'GROUP_ESCALATION');
 INSERT INTO public.runs(tenant_id,id,task_id,owner_id,status,budget,persona_context_state,result,result_classification) VALUES(tenant,p_run,p_task,actor,'SUCCEEDED','{"schemaVersion":1,"maxTurns":0,"maxTools":0,"maxActiveMs":1}'::jsonb,'BUILTIN_ONLY',p_body,'INTERNAL');
 INSERT INTO public.deliveries(tenant_id,id,owner_id,task_id,target,args_hash,state,content_ref,classification,source_run_id,source_session_no) VALUES(tenant,p_delivery,actor,p_task,target,p_content_hash,'PENDING',p_cipher::text,'INTERNAL',p_run,1);
 INSERT INTO public.outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES(tenant,p_delivery,actor,'GROUP_ESCALATION',p_id,jsonb_build_object('proposalId',p_id,'claimId',p_claim,'contentHash',p_content_hash),'group-escalation:'||p_id::text,clock_timestamp());
 UPDATE public.group_case_escalations SET task_id=p_task,run_id=p_run,delivery_id=p_delivery,updated_at=clock_timestamp() WHERE tenant_id=tenant AND id=p_id RETURNING * INTO e;
 RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_stage(uuid,uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_stage(uuid,uuid,uuid,uuid,uuid,text,jsonb,text) TO oa_runtime;

CREATE FUNCTION public.oa_group_escalation_settle(p_id uuid,p_claim uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;e public.group_case_escalations;outcome text;
BEGIN
 SELECT * INTO e FROM public.group_case_escalations WHERE tenant_id=tenant AND id=p_id AND service_owner_id=actor AND claim_id=p_claim FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_ESCALATION_NOT_FOUND';END IF;
 IF e.state<>'CLAIMED' THEN RETURN to_jsonb(e);END IF;
 SELECT CASE WHEN d.state IN ('APPLIED_UNVERIFIED','FAILED','SUPPRESSED','UNKNOWN') THEN d.state ELSE 'UNKNOWN' END INTO outcome FROM public.deliveries d WHERE d.tenant_id=tenant AND d.id=e.delivery_id AND d.owner_id=actor AND d.source_run_id=e.run_id;
 UPDATE public.group_case_escalations SET state=coalesce(outcome,'UNKNOWN'),last_error=CASE WHEN coalesce(outcome,'UNKNOWN')='UNKNOWN' THEN 'DELIVERY_RECONCILIATION_REQUIRED' ELSE last_error END,updated_at=clock_timestamp() WHERE tenant_id=tenant AND id=p_id RETURNING * INTO e;RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_settle(uuid,uuid) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_settle(uuid,uuid) TO oa_runtime;

-- Owner-only status metadata survives source withdrawal; no old preview, body,
-- provider identifiers, credential or new send authority is returned.
CREATE FUNCTION public.oa_group_escalation_receipt(p_id uuid,p_session uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;e public.group_case_escalations;d public.deliveries;result_state text;
BEGIN
 SELECT x.* INTO e FROM public.group_case_escalations x JOIN public.sessions s ON s.tenant_id=x.tenant_id AND s.id=x.session_id AND s.owner_id=x.administrator_id
 JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=s.tenant_id
 WHERE x.tenant_id=tenant AND x.id=p_id AND x.administrator_id=actor AND x.session_id=p_session AND x.auth_epoch=s.auth_epoch AND s.auth_epoch=u.auth_epoch
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='ACTIVE' AND t.status='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_ESCALATION_NOT_FOUND';END IF;
 SELECT * INTO d FROM public.deliveries WHERE tenant_id=tenant AND id=e.delivery_id AND owner_id=e.service_owner_id AND source_run_id=e.run_id AND task_id=e.task_id;
 result_state:=CASE WHEN e.state='UNKNOWN' THEN 'UNKNOWN' WHEN e.state='QUEUED' AND e.expires_at<=clock_timestamp() THEN 'SUPPRESSED' WHEN d.id IS NOT NULL THEN CASE WHEN d.state='SENT' THEN 'APPLIED_UNVERIFIED' ELSE d.state END
 WHEN e.state='CLAIMED' THEN CASE WHEN e.expires_at<=clock_timestamp() THEN 'UNKNOWN' ELSE 'PENDING' END
 WHEN e.state IN ('APPLIED_UNVERIFIED','FAILED','SUPPRESSED') THEN e.state ELSE 'UNKNOWN' END;
 RETURN jsonb_build_object('state',result_state,'verification','UNVERIFIED','method',CASE WHEN d.message_id IS NOT NULL THEN 'PROVIDER_ACCEPTANCE_ONLY' ELSE 'NO_PROVIDER_RECEIPT' END,'physicalDeliveryVerified',false,'asOf',clock_timestamp(),'notice','记录仅描述本地投递和提供方回执，不证明接收方已收到或阅读；UNKNOWN 不重发。');
END $$;
REVOKE ALL ON FUNCTION public.oa_group_escalation_receipt(uuid,uuid) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_escalation_receipt(uuid,uuid) TO oa_runtime;
