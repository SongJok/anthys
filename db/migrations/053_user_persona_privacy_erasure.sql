ALTER TABLE persona_revisions ADD COLUMN privacy_erased_at timestamptz;
ALTER TABLE persona_revisions ADD CHECK(privacy_erased_at IS NULL OR scope_kind='USER' AND settings_ref='{}'::jsonb AND settings_hash='44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
ALTER TABLE persona_revisions DROP CONSTRAINT persona_revisions_source_kind_check;
ALTER TABLE persona_revisions ADD CHECK(source_kind IN ('H5','DINGTALK_TEXT','PRIVACY_ERASURE'));
ALTER TABLE persona_change_requests ADD COLUMN privacy_erased_at timestamptz;
ALTER TABLE persona_change_requests ADD CHECK(privacy_erased_at IS NULL OR input_ref='{}'::jsonb);
CREATE TABLE persona_privacy_state (
 tenant_id uuid NOT NULL,owner_id uuid NOT NULL,persona_id uuid NOT NULL,through_version bigint NOT NULL CHECK(through_version>=0),
 marker_revision_id uuid NOT NULL,marker_version bigint NOT NULL CHECK(marker_version>through_version),generation bigint NOT NULL CHECK(generation>0),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,owner_id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,persona_id) REFERENCES personas(tenant_id,id)
);
CREATE TABLE persona_privacy_erasures (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,persona_id uuid NOT NULL,request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
 source_kind text NOT NULL CHECK(source_kind IN ('H5','DINGTALK_TEXT')),source_reference uuid NOT NULL,through_version bigint NOT NULL,generation bigint NOT NULL,receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,request_key),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,persona_id) REFERENCES personas(tenant_id,id)
);
ALTER TABLE persona_privacy_state ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_privacy_state FORCE ROW LEVEL SECURITY;
CREATE POLICY private_owner ON persona_privacy_state USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_persona_authority('USER',owner_id::text,false) IS NOT NULL);
ALTER TABLE persona_privacy_erasures ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_privacy_erasures FORCE ROW LEVEL SECURITY;
CREATE POLICY private_owner ON persona_privacy_erasures USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_persona_authority('USER',owner_id::text,false) IS NOT NULL);
GRANT SELECT ON persona_privacy_state,persona_privacy_erasures TO oa_app,oa_runtime;
CREATE FUNCTION public.oa_user_persona_erasure_cutoff(kind_arg text,scope_arg text) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN kind_arg='USER' AND scope_arg=nullif(current_setting('app.actor_id',true),'')::uuid::text THEN coalesce((SELECT through_version FROM public.persona_privacy_state WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid),0) ELSE 0 END;
$$;
REVOKE ALL ON FUNCTION public.oa_user_persona_erasure_cutoff(text,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.oa_user_persona_erasure_cutoff(text,text) TO oa_app,oa_runtime;
CREATE OR REPLACE FUNCTION public.oa_persona_revision_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE restore_marker boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM public.persona_privacy_state s JOIN public.persona_revisions r ON r.tenant_id=s.tenant_id AND r.id=s.marker_revision_id AND r.persona_id=s.persona_id WHERE s.tenant_id=NEW.tenant_id AND s.owner_id::text=NEW.scope_id AND NEW.scope_kind='USER' AND s.persona_id=NEW.id AND s.marker_revision_id=NEW.current_revision_id AND s.marker_version=NEW.version AND OLD.version<NEW.version AND r.privacy_erased_at IS NOT NULL) INTO restore_marker;
 IF (NEW.version<>OLD.version+1 AND NOT restore_marker) OR NOT EXISTS(SELECT 1 FROM public.persona_revisions r WHERE r.tenant_id=NEW.tenant_id AND r.persona_id=NEW.id AND r.id=NEW.current_revision_id AND r.version_no=NEW.version) THEN RAISE EXCEPTION 'PERSONA_REVISION_POINTER_INVALID' USING ERRCODE='23514';END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
-- Only checked erasure functions may invoke this content-only helper.
CREATE FUNCTION public.oa_purge_persona_run_content(run_ids uuid[],reason_arg text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;task_ids uuid[];affected bigint;counts jsonb='{{}}';
BEGIN
 IF reason_arg<>'PERSONA_PRIVACY_ERASED' OR EXISTS(SELECT 1 FROM unnest(run_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.runs r WHERE r.tenant_id=tenant_arg AND r.owner_id=actor_arg AND r.id=x)) THEN RAISE EXCEPTION 'PERSONA_PURGE_SCOPE_INVALID' USING ERRCODE='42501';END IF;
 PERFORM id FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids) ORDER BY id FOR UPDATE;
 SELECT coalesce(array_agg(DISTINCT task_id),'{{}}'::uuid[]) INTO task_ids FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids);
 UPDATE public.tasks SET status='CANCELLED',cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND requester_id=actor_arg AND id=ANY(task_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('tasks',affected);
 UPDATE public.runs SET status='CANCELLED',fence=fence+1,lease_owner=NULL,lease_until=NULL,result=NULL,context_ref=NULL,last_error=reason_arg,updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('runs',affected);
 UPDATE public.run_persona_snapshots SET revoked_at=coalesce(revoked_at,clock_timestamp()),proof_ref='{}',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('snapshots',affected);
 DELETE FROM public.provider_journals WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('journals',affected);
 DELETE FROM public.context_checkpoints WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('checkpoints',affected);
 UPDATE public.run_steps SET input_hash=NULL,result_ref=NULL,safe_payload='{"erased":true}',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('steps',affected);
 UPDATE public.tool_actions SET input_ref=NULL,result=NULL,state=CASE WHEN state='EXECUTING' THEN 'UNKNOWN' WHEN state IN ('PREPARED','APPROVAL_REQUIRED','APPROVED') THEN 'CANCELLED' ELSE state END,updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('actions',affected);
 UPDATE public.run_finalizations SET plan_ref='{}',state='REJECTED',output_hash=NULL,reason=reason_arg,updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('finalizations',affected);
 UPDATE public.run_narrative_reviews SET review_ref='{}',answered_at=coalesce(answered_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('reviews',affected);
 UPDATE public.run_user_messages SET message_ref=NULL,content_state='LEGACY_UNAVAILABLE',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('messages',affected);
 UPDATE public.run_source_choices SET payload_ref='{}',answered_at=coalesce(answered_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('choices',affected);
 UPDATE public.source_choice_replies SET answer_ref='{}',state=CASE WHEN state='PENDING' THEN 'REJECTED' ELSE state END,worker_generation=worker_generation+1,rejection_code=reason_arg,updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('choiceReplies',affected);
 UPDATE public.deliveries SET content_ref='{}',state=CASE WHEN state='SENDING' THEN 'UNKNOWN' WHEN state IN ('PENDING','FAILED') THEN 'SUPPRESSED' ELSE state END,last_error=reason_arg,updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND source_run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('deliveries',affected);
 UPDATE public.outbox SET payload_ref=jsonb_build_object('tenantId',tenant_arg,'actorId',actor_arg,'erased',true),published_at=coalesce(published_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND (aggregate_id=ANY(run_ids) OR aggregate_id=ANY(task_ids) OR payload_ref->>'runId'=ANY(SELECT x::text FROM unnest(run_ids) x) OR payload_ref->>'taskId'=ANY(SELECT x::text FROM unnest(task_ids) x) OR aggregate_id IN (SELECT id FROM public.source_choice_replies WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids)));
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('outbox',affected);
 RETURN counts;END $$;
REVOKE ALL ON FUNCTION public.oa_purge_persona_run_content(uuid[],text) FROM PUBLIC;
CREATE FUNCTION public.oa_erase_user_persona(request_arg text,source_arg text,reference_arg uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 persona_arg uuid;through_arg bigint;marker_arg uuid=gen_random_uuid();marker_version_arg bigint;generation_arg bigint;erase_arg uuid=gen_random_uuid();authority jsonb;old_receipt jsonb;
 proposals uuid[];run_ids uuid[];inbox_ids uuid[];affected bigint;counts jsonb='{}';result jsonb;
BEGIN
 IF length(request_arg) NOT BETWEEN 8 AND 128 OR source_arg NOT IN ('H5','DINGTALK_TEXT') THEN RAISE EXCEPTION 'PERSONA_ERASURE_INPUT_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':persona:USER:'||actor_arg::text,0));
 authority=public.oa_persona_authority('USER',actor_arg::text,true);IF authority IS NULL THEN RAISE EXCEPTION 'PERSONA_ERASURE_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 IF source_arg='H5' AND NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.tenant_id=tenant_arg AND s.owner_id=actor_arg AND s.id=reference_arg AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_epoch=(authority->>'authEpoch')::bigint) OR source_arg='DINGTALK_TEXT' AND NOT EXISTS(SELECT 1 FROM public.event_inbox e WHERE e.tenant_id=tenant_arg AND e.owner_id=actor_arg AND e.id=reference_arg AND e.source='DINGTALK' AND e.state='RECEIVED') THEN RAISE EXCEPTION 'PERSONA_ERASURE_SOURCE_INVALID' USING ERRCODE='42501';END IF;
 SELECT receipt INTO old_receipt FROM public.persona_privacy_erasures WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND request_key=request_arg;
 IF old_receipt IS NOT NULL THEN RETURN old_receipt||jsonb_build_object('replayed',true);END IF;
 SELECT id INTO persona_arg FROM public.personas WHERE tenant_id=tenant_arg AND scope_kind='USER' AND scope_id=actor_arg::text FOR UPDATE;
 IF persona_arg IS NULL THEN persona_arg=gen_random_uuid();INSERT INTO public.personas(tenant_id,id,scope_kind,scope_id,created_by) VALUES(tenant_arg,persona_arg,'USER',actor_arg::text,actor_arg);END IF;
 SELECT greatest(p.version,coalesce((SELECT max(version_no) FROM public.persona_revisions r WHERE r.tenant_id=p.tenant_id AND r.persona_id=p.id),0),coalesce((SELECT marker_version FROM public.persona_privacy_state s WHERE s.tenant_id=p.tenant_id AND s.owner_id=actor_arg),0)) INTO through_arg FROM public.personas p WHERE p.tenant_id=tenant_arg AND p.id=persona_arg;
 SELECT coalesce(max(generation),0)+1 INTO generation_arg FROM public.persona_privacy_state WHERE tenant_id=tenant_arg AND owner_id=actor_arg;marker_version_arg=through_arg+1;
 SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO proposals FROM public.persona_scope_proposals WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND channel_kind='DM' AND (chosen_scope_kind IS NULL OR chosen_scope_kind='USER');
 SELECT coalesce(array_agg(DISTINCT run_id),'{}'::uuid[]) INTO run_ids FROM (
  SELECT s.run_id FROM public.run_persona_sources s WHERE s.tenant_id=tenant_arg AND s.owner_id=actor_arg AND s.persona_id=persona_arg AND s.scope_kind='USER' AND s.scope_id=actor_arg::text
  UNION SELECT p.run_id FROM public.persona_control_responses p JOIN public.persona_revisions r ON r.tenant_id=p.tenant_id AND r.id=p.revision_id WHERE p.tenant_id=tenant_arg AND p.owner_id=actor_arg AND r.persona_id=persona_arg AND r.scope_kind='USER'
  UNION SELECT p.run_id FROM public.persona_control_responses p WHERE p.tenant_id=tenant_arg AND p.owner_id=actor_arg AND p.proposal_id=ANY(proposals)
 ) dependent;
 SELECT coalesce(array_agg(DISTINCT id),'{}'::uuid[]) INTO inbox_ids FROM (
  SELECT e.id FROM public.persona_revisions r JOIN public.event_inbox e ON e.tenant_id=r.tenant_id AND e.owner_id=r.actor_id AND e.id::text=r.source_reference WHERE r.tenant_id=tenant_arg AND r.persona_id=persona_arg AND r.scope_kind='USER' AND r.source_kind='DINGTALK_TEXT' AND r.actor_id=actor_arg
  UNION SELECT p.source_event_id FROM public.persona_scope_proposals p WHERE p.tenant_id=tenant_arg AND p.owner_id=actor_arg AND p.id=ANY(proposals)
  UNION SELECT p.decision_event_id FROM public.persona_scope_proposals p WHERE p.tenant_id=tenant_arg AND p.owner_id=actor_arg AND p.id=ANY(proposals) AND p.decision_event_id IS NOT NULL
  UNION SELECT u.source_event_id FROM public.run_user_messages u WHERE u.tenant_id=tenant_arg AND u.owner_id=actor_arg AND u.run_id=ANY(run_ids) AND u.source_event_id IS NOT NULL
 ) related(id);
 counts=public.oa_purge_persona_run_content(run_ids,'PERSONA_PRIVACY_ERASED');
 UPDATE public.event_inbox SET payload_cipher_ref='{}',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(inbox_ids);GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('inboxes',affected);
 UPDATE public.persona_scope_proposals SET state='CANCELLED',proof_ref=NULL,rejection_code='PERSONA_PRIVACY_ERASED' WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(proposals) AND state='PENDING';GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('pendingProposals',affected);
 UPDATE public.persona_revisions SET settings_ref='{}',settings_hash='44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',privacy_erased_at=coalesce(privacy_erased_at,clock_timestamp()) WHERE tenant_id=tenant_arg AND persona_id=persona_arg AND scope_kind='USER' AND scope_id=actor_arg::text AND version_no<=through_arg AND privacy_erased_at IS NULL;GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('revisions',affected);
 UPDATE public.persona_change_requests q SET input_ref='{}',privacy_erased_at=coalesce(privacy_erased_at,clock_timestamp()) FROM public.persona_revisions r WHERE q.tenant_id=tenant_arg AND q.owner_id=actor_arg AND r.tenant_id=q.tenant_id AND r.id=q.revision_id AND r.persona_id=persona_arg AND r.scope_kind='USER' AND r.version_no<=through_arg;GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('requests',affected);
 INSERT INTO public.persona_revisions(tenant_id,id,persona_id,scope_kind,scope_id,version_no,settings_ref,settings_hash,actor_id,actor_auth_epoch,source_kind,source_reference,privacy_erased_at) VALUES(tenant_arg,marker_arg,persona_arg,'USER',actor_arg::text,marker_version_arg,'{}','44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',actor_arg,(authority->>'authEpoch')::bigint,'PRIVACY_ERASURE',erase_arg::text,clock_timestamp());
 INSERT INTO public.persona_privacy_state(tenant_id,owner_id,persona_id,through_version,marker_revision_id,marker_version,generation) VALUES(tenant_arg,actor_arg,persona_arg,through_arg,marker_arg,marker_version_arg,generation_arg) ON CONFLICT(tenant_id,owner_id) DO UPDATE SET persona_id=excluded.persona_id,through_version=excluded.through_version,marker_revision_id=excluded.marker_revision_id,marker_version=excluded.marker_version,generation=excluded.generation,updated_at=clock_timestamp();
 UPDATE public.personas SET current_revision_id=marker_arg,version=marker_version_arg WHERE tenant_id=tenant_arg AND id=persona_arg AND scope_kind='USER' AND scope_id=actor_arg::text;
 result=jsonb_build_object('erasureId',erase_arg,'version',marker_version_arg,'etag',to_jsonb(marker_arg::text)::text,'counts',counts,'replayed',false,'backupRetention','UNVERIFIED','alreadyDispatched','Cannot retract bytes already handed to an external recipient');
 INSERT INTO public.persona_privacy_erasures(tenant_id,id,owner_id,persona_id,request_key,source_kind,source_reference,through_version,generation,receipt) VALUES(tenant_arg,erase_arg,actor_arg,persona_arg,request_arg,source_arg,reference_arg,through_arg,generation_arg,result);RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_erase_user_persona(text,text,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.oa_erase_user_persona(text,text,uuid) TO oa_runtime;
ALTER TABLE persona_control_responses DROP CONSTRAINT persona_control_responses_outcome_check;
ALTER TABLE persona_control_responses ADD CHECK(outcome IN ('SAVED','VIEW','HELP','CLARIFY','DENIED','CONFLICT','LOCKED','UNAVAILABLE','AMBIGUOUS','CANCELLED','EXPIRED','NOT_FOUND','CONFIRM_REQUIRED','ERASED'));
