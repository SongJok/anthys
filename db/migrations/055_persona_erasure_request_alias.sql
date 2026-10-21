-- Qualify the request timestamp in the joined content erasure.
CREATE OR REPLACE FUNCTION public.oa_erase_user_persona(request_arg text,source_arg text,reference_arg uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
 UPDATE public.persona_change_requests q SET input_ref='{}',privacy_erased_at=coalesce(q.privacy_erased_at,clock_timestamp()) FROM public.persona_revisions r WHERE q.tenant_id=tenant_arg AND q.owner_id=actor_arg AND r.tenant_id=q.tenant_id AND r.id=q.revision_id AND r.persona_id=persona_arg AND r.scope_kind='USER' AND r.version_no<=through_arg;GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('requests',affected);
 INSERT INTO public.persona_revisions(tenant_id,id,persona_id,scope_kind,scope_id,version_no,settings_ref,settings_hash,actor_id,actor_auth_epoch,source_kind,source_reference,privacy_erased_at) VALUES(tenant_arg,marker_arg,persona_arg,'USER',actor_arg::text,marker_version_arg,'{}','44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',actor_arg,(authority->>'authEpoch')::bigint,'PRIVACY_ERASURE',erase_arg::text,clock_timestamp());
 INSERT INTO public.persona_privacy_state(tenant_id,owner_id,persona_id,through_version,marker_revision_id,marker_version,generation) VALUES(tenant_arg,actor_arg,persona_arg,through_arg,marker_arg,marker_version_arg,generation_arg) ON CONFLICT(tenant_id,owner_id) DO UPDATE SET persona_id=excluded.persona_id,through_version=excluded.through_version,marker_revision_id=excluded.marker_revision_id,marker_version=excluded.marker_version,generation=excluded.generation,updated_at=clock_timestamp();
 UPDATE public.personas SET current_revision_id=marker_arg,version=marker_version_arg WHERE tenant_id=tenant_arg AND id=persona_arg AND scope_kind='USER' AND scope_id=actor_arg::text;
 result=jsonb_build_object('erasureId',erase_arg,'version',marker_version_arg,'etag',to_jsonb(marker_arg::text)::text,'counts',counts,'replayed',false,'backupRetention','UNVERIFIED','alreadyDispatched','Cannot retract bytes already handed to an external recipient');
 INSERT INTO public.persona_privacy_erasures(tenant_id,id,owner_id,persona_id,request_key,source_kind,source_reference,through_version,generation,receipt) VALUES(tenant_arg,erase_arg,actor_arg,persona_arg,request_arg,source_arg,reference_arg,through_arg,generation_arg,result);RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_erase_user_persona(text,text,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.oa_erase_user_persona(text,text,uuid) TO oa_runtime;
