-- Exact contentless dependency IDs survive a trusted content-fragment restore.
-- They select original dependencies, rather than guessing from arrival times.
ALTER TABLE persona_privacy_erasures ADD COLUMN run_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE persona_privacy_erasures ADD COLUMN proposal_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE persona_privacy_erasures ADD COLUMN inbox_ids uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE persona_privacy_repairs(tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,generation bigint NOT NULL,counts jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id));
ALTER TABLE persona_privacy_repairs ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_privacy_repairs FORCE ROW LEVEL SECURITY;
CREATE POLICY private_owner ON persona_privacy_repairs USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_persona_authority('USER',owner_id::text,false) IS NOT NULL);
GRANT SELECT ON persona_privacy_repairs TO oa_app,oa_runtime;
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
 INSERT INTO public.persona_privacy_erasures(tenant_id,id,owner_id,persona_id,request_key,source_kind,source_reference,through_version,generation,receipt,run_ids,proposal_ids,inbox_ids) VALUES(tenant_arg,erase_arg,actor_arg,persona_arg,request_arg,source_arg,reference_arg,through_arg,generation_arg,result,run_ids,proposals,inbox_ids);RETURN result;
END $$;
CREATE FUNCTION public.oa_repair_user_persona_erasure() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;known public.persona_privacy_state%ROWTYPE;
 run_ids uuid[];proposals uuid[];inbox_ids uuid[];dirty boolean;affected bigint;counts jsonb;last_erasure uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 IF public.oa_persona_authority('USER',actor_arg::text,true) IS NULL THEN RETURN jsonb_build_object('status','SUBJECT_INACTIVE');END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':persona:USER:'||actor_arg::text,0));
 SELECT * INTO known FROM public.persona_privacy_state WHERE tenant_id=tenant_arg AND owner_id=actor_arg FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','NO_ERASURE');END IF;
 SELECT id INTO last_erasure FROM public.persona_privacy_erasures WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND generation=known.generation;
 IF last_erasure IS NULL THEN RAISE EXCEPTION 'PERSONA_ERASURE_LEDGER_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT coalesce(array_agg(DISTINCT x),'{}'::uuid[]) INTO proposals FROM public.persona_privacy_erasures e CROSS JOIN LATERAL unnest(e.proposal_ids) x WHERE e.tenant_id=tenant_arg AND e.owner_id=actor_arg;
 SELECT coalesce(array_agg(DISTINCT run_id),'{}'::uuid[]) INTO run_ids FROM (
  SELECT unnest(e.run_ids) run_id FROM public.persona_privacy_erasures e WHERE e.tenant_id=tenant_arg AND e.owner_id=actor_arg
  UNION SELECT s.run_id FROM public.run_persona_sources s JOIN public.persona_revisions r ON r.tenant_id=s.tenant_id AND r.id=s.revision_id AND r.persona_id=s.persona_id WHERE s.tenant_id=tenant_arg AND s.owner_id=actor_arg AND s.persona_id=known.persona_id AND s.scope_kind='USER' AND r.version_no<=known.through_version
  UNION SELECT p.run_id FROM public.persona_control_responses p JOIN public.persona_revisions r ON r.tenant_id=p.tenant_id AND r.id=p.revision_id WHERE p.tenant_id=tenant_arg AND p.owner_id=actor_arg AND r.persona_id=known.persona_id AND r.scope_kind='USER' AND r.version_no<=known.through_version
  UNION SELECT p.run_id FROM public.persona_control_responses p WHERE p.tenant_id=tenant_arg AND p.owner_id=actor_arg AND p.proposal_id=ANY(proposals)
 ) dependencies;
 SELECT coalesce(array_agg(DISTINCT id),'{}'::uuid[]) INTO inbox_ids FROM (
  SELECT unnest(e.inbox_ids) id FROM public.persona_privacy_erasures e WHERE e.tenant_id=tenant_arg AND e.owner_id=actor_arg
  UNION SELECT e.id FROM public.persona_revisions r JOIN public.event_inbox e ON e.tenant_id=r.tenant_id AND e.owner_id=r.actor_id AND e.id::text=r.source_reference WHERE r.tenant_id=tenant_arg AND r.persona_id=known.persona_id AND r.scope_kind='USER' AND r.source_kind='DINGTALK_TEXT' AND r.version_no<=known.through_version AND r.actor_id=actor_arg
  UNION SELECT u.source_event_id FROM public.run_user_messages u WHERE u.tenant_id=tenant_arg AND u.owner_id=actor_arg AND u.run_id=ANY(run_ids) AND u.source_event_id IS NOT NULL
 ) related;
 SELECT EXISTS(SELECT 1 FROM public.personas p WHERE p.tenant_id=tenant_arg AND p.id=known.persona_id AND p.version<=known.through_version)
 OR EXISTS(SELECT 1 FROM public.persona_revisions r WHERE r.tenant_id=tenant_arg AND r.persona_id=known.persona_id AND (r.version_no<=known.through_version OR r.id=known.marker_revision_id) AND (r.settings_ref<>'{}'::jsonb OR r.privacy_erased_at IS NULL))
 OR EXISTS(SELECT 1 FROM public.persona_change_requests q JOIN public.persona_revisions r ON r.tenant_id=q.tenant_id AND r.id=q.revision_id WHERE q.tenant_id=tenant_arg AND q.owner_id=actor_arg AND r.persona_id=known.persona_id AND r.version_no<=known.through_version AND (q.input_ref<>'{}'::jsonb OR q.privacy_erased_at IS NULL))
 OR EXISTS(SELECT 1 FROM public.persona_scope_proposals p WHERE p.tenant_id=tenant_arg AND p.owner_id=actor_arg AND p.id=ANY(proposals) AND (p.state='PENDING' OR p.proof_ref IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public.event_inbox e WHERE e.tenant_id=tenant_arg AND e.owner_id=actor_arg AND e.id=ANY(inbox_ids) AND e.payload_cipher_ref<>'{}')
 OR EXISTS(SELECT 1 FROM public.runs r WHERE r.tenant_id=tenant_arg AND r.owner_id=actor_arg AND r.id=ANY(run_ids) AND (
 r.status<>'CANCELLED' OR r.result IS NOT NULL OR r.context_ref IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.run_persona_snapshots p WHERE p.tenant_id=r.tenant_id AND p.run_id=r.id AND p.proof_ref<>'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM public.provider_journals j WHERE j.tenant_id=r.tenant_id AND j.run_id=r.id)
 OR EXISTS(SELECT 1 FROM public.context_checkpoints k WHERE k.tenant_id=r.tenant_id AND k.run_id=r.id)
 OR EXISTS(SELECT 1 FROM public.run_steps s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id AND (s.input_hash IS NOT NULL OR s.result_ref IS NOT NULL OR s.safe_payload<>'{"erased":true}'::jsonb))
 OR EXISTS(SELECT 1 FROM public.tool_actions a WHERE a.tenant_id=r.tenant_id AND a.run_id=r.id AND (a.input_ref IS NOT NULL OR a.result IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public.run_finalizations f WHERE f.tenant_id=r.tenant_id AND f.run_id=r.id AND f.plan_ref<>'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM public.run_narrative_reviews n WHERE n.tenant_id=r.tenant_id AND n.run_id=r.id AND n.review_ref<>'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM public.run_user_messages u WHERE u.tenant_id=r.tenant_id AND u.run_id=r.id AND u.message_ref IS NOT NULL)
 OR EXISTS(SELECT 1 FROM public.run_source_choices c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id AND c.payload_ref<>'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM public.source_choice_replies c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id AND c.answer_ref<>'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM public.deliveries d WHERE d.tenant_id=r.tenant_id AND d.owner_id=r.owner_id AND d.source_run_id=r.id AND d.content_ref<>'{}')
 OR EXISTS(SELECT 1 FROM public.outbox o WHERE o.tenant_id=r.tenant_id AND o.owner_id=r.owner_id AND (o.aggregate_id=r.id OR o.aggregate_id=r.task_id OR o.payload_ref->>'runId'=r.id::text OR o.payload_ref->>'taskId'=r.task_id::text OR o.aggregate_id IN (SELECT c.id FROM public.source_choice_replies c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id)) AND o.payload_ref->>'erased' IS DISTINCT FROM 'true')
 )) INTO dirty;
 IF NOT dirty THEN RETURN jsonb_build_object('status','CLEAN');END IF;
 counts=public.oa_purge_persona_run_content(run_ids,'PERSONA_PRIVACY_ERASED');
 UPDATE public.event_inbox SET payload_cipher_ref='{}',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(inbox_ids) AND payload_cipher_ref<>'{}';GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('inboxes',affected);
 UPDATE public.persona_scope_proposals SET state=CASE WHEN state='PENDING' THEN 'CANCELLED' ELSE state END,proof_ref=NULL,rejection_code='PERSONA_PRIVACY_ERASED' WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(proposals) AND (state='PENDING' OR proof_ref IS NOT NULL);GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('proposals',affected);
 UPDATE public.persona_revisions SET settings_ref='{}',settings_hash='44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',privacy_erased_at=coalesce(privacy_erased_at,clock_timestamp()) WHERE tenant_id=tenant_arg AND persona_id=known.persona_id AND scope_kind='USER' AND scope_id=actor_arg::text AND (version_no<=known.through_version OR id=known.marker_revision_id) AND (settings_ref<>'{}'::jsonb OR privacy_erased_at IS NULL);GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('revisions',affected);
 UPDATE public.persona_change_requests q SET input_ref='{}',privacy_erased_at=coalesce(q.privacy_erased_at,clock_timestamp()) FROM public.persona_revisions r WHERE q.tenant_id=tenant_arg AND q.owner_id=actor_arg AND r.tenant_id=q.tenant_id AND r.id=q.revision_id AND r.persona_id=known.persona_id AND r.version_no<=known.through_version AND (q.input_ref<>'{}'::jsonb OR q.privacy_erased_at IS NULL);GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('requests',affected);
 IF EXISTS(SELECT 1 FROM public.personas WHERE tenant_id=tenant_arg AND id=known.persona_id AND version<=known.through_version) THEN
  INSERT INTO public.persona_revisions(tenant_id,id,persona_id,scope_kind,scope_id,version_no,settings_ref,settings_hash,actor_id,actor_auth_epoch,source_kind,source_reference,privacy_erased_at) SELECT tenant_arg,known.marker_revision_id,known.persona_id,'USER',actor_arg::text,known.marker_version,'{}','44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',actor_arg,auth_epoch,'PRIVACY_ERASURE',last_erasure::text,clock_timestamp() FROM public.users WHERE tenant_id=tenant_arg AND id=actor_arg ON CONFLICT(tenant_id,id) DO NOTHING;
  UPDATE public.personas SET current_revision_id=known.marker_revision_id,version=known.marker_version WHERE tenant_id=tenant_arg AND id=known.persona_id AND scope_kind='USER' AND scope_id=actor_arg::text AND version<=known.through_version;
 END IF;
 INSERT INTO public.persona_privacy_repairs(tenant_id,id,owner_id,generation,counts) VALUES(tenant_arg,gen_random_uuid(),actor_arg,known.generation,counts);
 RETURN jsonb_build_object('status','REPAIRED','counts',counts);
END $$;
REVOKE ALL ON FUNCTION public.oa_repair_user_persona_erasure() FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.oa_repair_user_persona_erasure() TO oa_runtime;
