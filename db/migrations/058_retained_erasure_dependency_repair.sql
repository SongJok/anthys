-- Retained opaque ledger edges support repair even if a restorer loses graph rows.
ALTER TABLE memory_deletions ADD COLUMN inbox_ids uuid[] NOT NULL DEFAULT '{}';
CREATE OR REPLACE FUNCTION public.oa_memory_deletion_run_ids() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT coalesce(array_agg(DISTINCT s.run_id),'{}'::uuid[]) INTO NEW.run_ids FROM public.run_memory_sources s WHERE s.tenant_id=NEW.tenant_id AND s.owner_id=NEW.owner_id AND s.memory_id=NEW.memory_id;
 SELECT coalesce(array_agg(DISTINCT event_id),'{}'::uuid[]) INTO NEW.inbox_ids FROM (
  SELECT event_id FROM public.memory_control_responses WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id AND memory_id=NEW.memory_id AND outcome IN ('SAVED','CORRECTED')
  UNION SELECT source_event_id FROM public.run_user_messages WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id AND run_id=ANY(NEW.run_ids) AND source_event_id IS NOT NULL
 ) sources;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.oa_erase_private_memory_content(memory_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 run_ids uuid[];task_ids uuid[];inbox_ids uuid[];affected bigint;counts jsonb='{}';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 IF NOT public.oa_memory_owner(actor_arg) OR NOT EXISTS(SELECT 1 FROM public.memory_items WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=memory_arg AND state='DELETED') THEN RAISE EXCEPTION 'MEMORY_ERASURE_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT run_id),'{}'::uuid[]) INTO run_ids FROM (SELECT run_id FROM public.run_memory_sources WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg UNION SELECT unnest(d.run_ids) FROM public.memory_deletions d WHERE d.tenant_id=tenant_arg AND d.owner_id=actor_arg AND d.memory_id=memory_arg) dependencies;
 PERFORM id FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids) ORDER BY id FOR UPDATE;
 SELECT coalesce(array_agg(DISTINCT task_id),'{}'::uuid[]) INTO task_ids FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids);
 SELECT coalesce(array_agg(DISTINCT event_id),'{}'::uuid[]) INTO inbox_ids FROM (
  SELECT unnest(d.inbox_ids) event_id FROM public.memory_deletions d WHERE d.tenant_id=tenant_arg AND d.owner_id=actor_arg AND d.memory_id=memory_arg
  UNION SELECT source_reference event_id FROM public.memory_revisions WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg AND source_kind='DINGTALK_TEXT'
  UNION SELECT event_id FROM public.memory_control_responses WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg AND outcome IN ('SAVED','CORRECTED')
  UNION SELECT source_event_id FROM public.run_user_messages WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids) AND source_event_id IS NOT NULL
 ) related;
 UPDATE public.event_inbox SET payload_cipher_ref='{}',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(inbox_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('inboxes',affected);
 UPDATE public.tasks SET status='CANCELLED',cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND requester_id=actor_arg AND id=ANY(task_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('tasks',affected);
 UPDATE public.runs SET status='CANCELLED',fence=fence+1,lease_owner=NULL,lease_until=NULL,result=NULL,context_ref=NULL,last_error='MEMORY_DELETED',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids);
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
 UPDATE public.run_finalizations SET plan_ref='{}',state='REJECTED',output_hash=NULL,reason='MEMORY_DELETED',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('finalizations',affected);
 UPDATE public.run_narrative_reviews SET review_ref='{}',answered_at=coalesce(answered_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('reviews',affected);
 UPDATE public.run_user_messages SET message_ref=NULL,content_state='LEGACY_UNAVAILABLE',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('messages',affected);
 UPDATE public.run_source_choices SET payload_ref='{}',answered_at=coalesce(answered_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('choices',affected);
 UPDATE public.source_choice_replies SET answer_ref='{}',state=CASE WHEN state='PENDING' THEN 'REJECTED' ELSE state END,worker_generation=worker_generation+1,rejection_code='MEMORY_DELETED',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('choiceReplies',affected);
 UPDATE public.deliveries SET content_ref='{}',state=CASE WHEN state='SENDING' THEN 'UNKNOWN' WHEN state IN ('PENDING','FAILED') THEN 'SUPPRESSED' ELSE state END,last_error='MEMORY_DELETED',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND source_run_id=ANY(run_ids);
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('deliveries',affected);
 UPDATE public.outbox SET payload_ref=jsonb_build_object('tenantId',tenant_arg,'actorId',actor_arg,'erased',true),published_at=coalesce(published_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND (aggregate_id=ANY(run_ids) OR aggregate_id=ANY(task_ids) OR payload_ref->>'runId'=ANY(SELECT x::text FROM unnest(run_ids) x) OR payload_ref->>'taskId'=ANY(SELECT x::text FROM unnest(task_ids) x) OR aggregate_id IN (SELECT id FROM public.source_choice_replies WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids)));
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('outbox',affected);
 DELETE FROM public.memory_search_index WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg;
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('indexes',affected);
 UPDATE public.memory_requests SET input_ref=NULL,state='CONTENT_REMOVED',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg;
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('requests',affected);
 DELETE FROM public.memory_revisions WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg;
 GET DIAGNOSTICS affected=ROW_COUNT;counts=counts||jsonb_build_object('revisions',affected);
 RETURN counts;
END $$;
REVOKE ALL ON FUNCTION public.oa_erase_private_memory_content(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_erase_private_memory_content(uuid) TO oa_runtime;

CREATE OR REPLACE FUNCTION public.oa_repair_user_persona_erasure() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
 r.status<>'CANCELLED' OR EXISTS(SELECT 1 FROM public.tasks t WHERE t.tenant_id=r.tenant_id AND t.id=r.task_id AND (t.status<>'CANCELLED' OR t.cancel_requested_at IS NULL)) OR r.result IS NOT NULL OR r.context_ref IS NOT NULL
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
