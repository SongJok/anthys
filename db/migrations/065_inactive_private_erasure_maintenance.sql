-- Background erasure does not restore departed users' read/write authority.
-- New private helpers expose only counts/status; no bodies or cross-owner IDs.
-- Security-definer guidance: https://www.postgresql.org/docs/17/sql-createfunction.html
CREATE OR REPLACE FUNCTION public.oa_memory_pointer() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE known_version bigint;
BEGIN
 SELECT d.deleted_version INTO known_version FROM public.memory_deletions d
  WHERE d.tenant_id=OLD.tenant_id AND d.owner_id=OLD.owner_id AND d.memory_id=OLD.id;
 IF known_version IS NOT NULL AND NEW.state='DELETED' AND NEW.current_revision_id IS NULL
  AND NEW.deleted_at IS NOT NULL AND NEW.version=known_version AND OLD.version<=known_version
  AND (NEW.tenant_id,NEW.id,NEW.owner_id,NEW.scope_kind,NEW.kind) IS NOT DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.owner_id,OLD.scope_kind,OLD.kind)
 THEN NEW.updated_at=clock_timestamp();RETURN NEW;END IF;
 IF OLD.state='DELETED' OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'MEMORY_STATE_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NEW.state='ACTIVE' AND NOT EXISTS(SELECT 1 FROM public.memory_revisions r WHERE r.tenant_id=NEW.tenant_id AND r.memory_id=NEW.id AND r.owner_id=NEW.owner_id AND r.id=NEW.current_revision_id AND r.revision_no=NEW.version) THEN RAISE EXCEPTION 'MEMORY_REVISION_POINTER_INVALID' USING ERRCODE='23514';END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE FUNCTION public.oa_purge_private_memory_content(memory_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 run_ids uuid[];task_ids uuid[];inbox_ids uuid[];affected bigint;counts jsonb='{}';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.memory_items WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=memory_arg AND state='DELETED') THEN RAISE EXCEPTION 'MEMORY_ERASURE_ROOT_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT coalesce(array_agg(DISTINCT run_id),'{}'::uuid[]) INTO run_ids FROM (SELECT run_id FROM public.run_memory_sources WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg UNION SELECT unnest(d.run_ids) FROM public.memory_deletions d WHERE d.tenant_id=tenant_arg AND d.owner_id=actor_arg AND d.memory_id=memory_arg) dependencies;
 PERFORM id FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids) ORDER BY id FOR UPDATE;
 SELECT coalesce(array_agg(DISTINCT task_id),'{}'::uuid[]) INTO task_ids FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids);
 SELECT coalesce(array_agg(DISTINCT event_id),'{}'::uuid[]) INTO inbox_ids FROM (
  SELECT unnest(d.inbox_ids) event_id FROM public.memory_deletions d WHERE d.tenant_id=tenant_arg AND d.owner_id=actor_arg AND d.memory_id=memory_arg
  UNION SELECT source_reference event_id FROM public.memory_revisions WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg AND source_kind='DINGTALK_TEXT'
  UNION SELECT event_id FROM public.memory_control_responses WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg AND outcome IN ('SAVED','CORRECTED')
  UNION SELECT source_event_id FROM public.run_user_messages WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids) AND source_event_id IS NOT NULL
  UNION SELECT source_event_id FROM public.source_choice_replies WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND run_id=ANY(run_ids) AND source_event_id IS NOT NULL
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
REVOKE ALL ON FUNCTION public.oa_purge_private_memory_content(uuid) FROM PUBLIC;
CREATE FUNCTION public.oa_private_memory_dirty(memory_arg uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
BEGIN
 RETURN EXISTS(SELECT d.memory_id FROM public.memory_deletions d JOIN public.memory_items m ON m.tenant_id=d.tenant_id AND m.id=d.memory_id AND m.owner_id=d.owner_id WHERE d.tenant_id=tenant_arg AND d.owner_id=actor_arg AND d.memory_id=memory_arg AND (m.state<>'DELETED' OR m.version<>d.deleted_version OR EXISTS(SELECT 1 FROM public.memory_revisions r WHERE r.tenant_id=d.tenant_id AND r.memory_id=d.memory_id) OR EXISTS(SELECT 1 FROM public.memory_search_index i WHERE i.tenant_id=d.tenant_id AND i.memory_id=d.memory_id) OR EXISTS(SELECT 1 FROM public.memory_requests q WHERE q.tenant_id=d.tenant_id AND q.memory_id=d.memory_id AND q.input_ref IS NOT NULL) OR EXISTS(SELECT 1 FROM public.event_inbox retained_inbox WHERE retained_inbox.tenant_id=d.tenant_id AND retained_inbox.owner_id=d.owner_id AND retained_inbox.id=ANY(d.inbox_ids) AND retained_inbox.payload_cipher_ref<>'{}') OR EXISTS(SELECT 1 FROM public.memory_control_responses p JOIN public.event_inbox e ON e.tenant_id=p.tenant_id AND e.id=p.event_id AND e.owner_id=p.owner_id WHERE p.tenant_id=d.tenant_id AND p.memory_id=d.memory_id AND p.owner_id=d.owner_id AND p.outcome IN ('SAVED','CORRECTED') AND e.payload_cipher_ref<>'{}') OR EXISTS(SELECT 1 FROM (SELECT tenant_id,owner_id,memory_id,run_id,task_id FROM public.run_memory_sources UNION SELECT retained.tenant_id,retained.owner_id,retained.memory_id,retained_run.id,retained_run.task_id FROM public.memory_deletions retained CROSS JOIN LATERAL unnest(retained.run_ids) edge(run_id) JOIN public.runs retained_run ON retained_run.tenant_id=retained.tenant_id AND retained_run.owner_id=retained.owner_id AND retained_run.id=edge.run_id) s JOIN public.runs r ON r.tenant_id=s.tenant_id AND r.id=s.run_id AND r.owner_id=s.owner_id WHERE s.tenant_id=d.tenant_id AND s.owner_id=d.owner_id AND s.memory_id=d.memory_id AND (r.status<>'CANCELLED' OR EXISTS(SELECT 1 FROM public.tasks t WHERE t.tenant_id=r.tenant_id AND t.id=r.task_id AND (t.status<>'CANCELLED' OR t.cancel_requested_at IS NULL)) OR r.result IS NOT NULL OR r.context_ref IS NOT NULL OR EXISTS(SELECT 1 FROM public.provider_journals j WHERE j.tenant_id=s.tenant_id AND j.run_id=s.run_id) OR EXISTS(SELECT 1 FROM public.context_checkpoints k WHERE k.tenant_id=s.tenant_id AND k.run_id=s.run_id) OR EXISTS(SELECT 1 FROM public.run_persona_snapshots p WHERE p.tenant_id=s.tenant_id AND p.run_id=s.run_id AND p.proof_ref<>'{}'::jsonb) OR EXISTS(SELECT 1 FROM public.run_steps step WHERE step.tenant_id=s.tenant_id AND step.run_id=s.run_id AND (step.result_ref IS NOT NULL OR step.input_hash IS NOT NULL OR step.safe_payload<>'{"erased":true}'::jsonb)) OR EXISTS(SELECT 1 FROM public.outbox o WHERE o.tenant_id=s.tenant_id AND o.owner_id=s.owner_id AND (o.aggregate_id=s.run_id OR o.aggregate_id=s.task_id OR o.payload_ref->>'runId'=s.run_id::text OR o.payload_ref->>'taskId'=s.task_id::text OR o.aggregate_id IN (SELECT choice.id FROM public.source_choice_replies choice WHERE choice.tenant_id=s.tenant_id AND choice.owner_id=s.owner_id AND choice.run_id=s.run_id)) AND o.payload_ref->>'erased' IS DISTINCT FROM 'true') OR EXISTS(SELECT 1 FROM public.tool_actions a WHERE a.tenant_id=s.tenant_id AND a.run_id=s.run_id AND (a.input_ref IS NOT NULL OR a.result IS NOT NULL)) OR EXISTS(SELECT 1 FROM public.run_finalizations f WHERE f.tenant_id=s.tenant_id AND f.run_id=s.run_id AND f.plan_ref<>'{}'::jsonb) OR EXISTS(SELECT 1 FROM public.run_narrative_reviews n WHERE n.tenant_id=s.tenant_id AND n.run_id=s.run_id AND n.review_ref<>'{}'::jsonb) OR EXISTS(SELECT 1 FROM public.run_user_messages u WHERE u.tenant_id=s.tenant_id AND u.run_id=s.run_id AND u.message_ref IS NOT NULL) OR EXISTS(SELECT 1 FROM public.run_user_messages u JOIN public.event_inbox e ON e.tenant_id=u.tenant_id AND e.id=u.source_event_id AND e.owner_id=u.owner_id WHERE u.tenant_id=s.tenant_id AND u.run_id=s.run_id AND e.payload_cipher_ref<>'{}') OR EXISTS(SELECT 1 FROM public.source_choice_replies choice JOIN public.event_inbox e ON e.tenant_id=choice.tenant_id AND e.id=choice.source_event_id AND e.owner_id=choice.owner_id WHERE choice.tenant_id=s.tenant_id AND choice.run_id=s.run_id AND e.payload_cipher_ref<>'{}') OR EXISTS(SELECT 1 FROM public.run_source_choices v WHERE v.tenant_id=s.tenant_id AND v.run_id=s.run_id AND v.payload_ref<>'{}'::jsonb) OR EXISTS(SELECT 1 FROM public.source_choice_replies a WHERE a.tenant_id=s.tenant_id AND a.run_id=s.run_id AND a.answer_ref<>'{}'::jsonb) OR EXISTS(SELECT 1 FROM public.deliveries v WHERE v.tenant_id=s.tenant_id AND v.source_run_id=s.run_id AND v.content_ref<>'{}')))));
END $$;
REVOKE ALL ON FUNCTION public.oa_private_memory_dirty(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.oa_erase_private_memory_content(memory_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.memory_items WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=memory_arg AND state='DELETED')
  OR NOT (public.oa_memory_owner(actor_arg) OR
   EXISTS(SELECT 1 FROM public.users u JOIN public.memory_deletions d ON d.tenant_id=u.tenant_id AND d.owner_id=u.id
    WHERE u.tenant_id=tenant_arg AND u.id=actor_arg AND d.memory_id=memory_arg))
 THEN RAISE EXCEPTION 'MEMORY_ERASURE_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 RETURN public.oa_purge_private_memory_content(memory_arg);
END $$;
REVOKE ALL ON FUNCTION public.oa_erase_private_memory_content(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_erase_private_memory_content(uuid) TO oa_runtime;

CREATE FUNCTION public.oa_repair_private_memory(memory_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 known_version bigint; root_version bigint; counts jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE tenant_id=tenant_arg AND id=actor_arg) THEN RAISE EXCEPTION 'MEMORY_ERASURE_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 SELECT deleted_version INTO known_version FROM public.memory_deletions WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEMORY_ERASURE_LEDGER_REQUIRED' USING ERRCODE='42501';END IF;
 SELECT version INTO root_version FROM public.memory_items WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=memory_arg FOR UPDATE;
 IF NOT FOUND OR root_version>known_version THEN RAISE EXCEPTION 'MEMORY_ERASURE_ROOT_CONFLICT' USING ERRCODE='23514';END IF;
 IF NOT public.oa_private_memory_dirty(memory_arg) THEN RETURN '{}'::jsonb;END IF;
 UPDATE public.memory_items SET state='DELETED',current_revision_id=NULL,deleted_at=coalesce(deleted_at,clock_timestamp()),version=known_version
  WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=memory_arg AND (state<>'DELETED' OR version<>known_version);
 counts=public.oa_erase_private_memory_content(memory_arg);
 INSERT INTO public.memory_erasure_repairs(tenant_id,id,owner_id,memory_id,counts) VALUES(tenant_arg,gen_random_uuid(),actor_arg,memory_arg,counts);
 RETURN counts;
END $$;
REVOKE ALL ON FUNCTION public.oa_repair_private_memory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_repair_private_memory(uuid) TO oa_runtime;

CREATE FUNCTION public.oa_maintain_private_preferences(limit_arg integer,backup_days integer,review_reference text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 row_arg record; expired_ids uuid[];dirty_ids uuid[];counts jsonb;
 request_arg uuid;generation_arg bigint;deleted_version_arg bigint;expired_count integer=0;repaired_count integer=0;
BEGIN
 IF limit_arg IS NULL OR limit_arg<1 OR limit_arg>100 OR (backup_days IS NULL)<>(review_reference IS NULL)
  OR backup_days IS NOT NULL AND (backup_days<1 OR length(review_reference)=0)
 THEN RAISE EXCEPTION 'MEMORY_MAINTENANCE_ARGUMENT_INVALID' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=tenant_arg AND u.id=actor_arg)
 THEN RETURN jsonb_build_object('status','SUBJECT_INACTIVE','expired',0,'repaired',0,'more',false);END IF;
 SELECT coalesce(array_agg(id ORDER BY valid_to,id),'{}'::uuid[]) INTO expired_ids FROM (
  SELECT m.id,r.valid_to FROM public.memory_items m JOIN public.memory_revisions r ON r.tenant_id=m.tenant_id AND r.id=m.current_revision_id AND r.memory_id=m.id AND r.owner_id=m.owner_id
  WHERE m.tenant_id=tenant_arg AND m.owner_id=actor_arg AND m.state='ACTIVE' AND r.valid_to<=clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM public.memory_deletions d WHERE d.tenant_id=m.tenant_id AND d.memory_id=m.id)
  ORDER BY r.valid_to,m.id LIMIT limit_arg+1
 ) expired;
 FOR row_arg IN SELECT m.id,m.version,r.valid_to FROM public.memory_items m JOIN public.memory_revisions r ON r.tenant_id=m.tenant_id AND r.id=m.current_revision_id AND r.memory_id=m.id AND r.owner_id=m.owner_id
  WHERE m.tenant_id=tenant_arg AND m.owner_id=actor_arg AND m.id=ANY(expired_ids[1:limit_arg]) AND m.state='ACTIVE' ORDER BY r.valid_to,m.id FOR UPDATE OF m
 LOOP
  -- Recheck wall time and current revision after locks; corrections share the barrier.
  IF row_arg.valid_to>clock_timestamp() THEN CONTINUE;END IF;
  UPDATE public.memory_items SET state='DELETED',current_revision_id=NULL,deleted_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND id=row_arg.id AND owner_id=actor_arg RETURNING version INTO deleted_version_arg;
  request_arg=gen_random_uuid();
  INSERT INTO public.memory_requests(tenant_id,id,owner_id,request_key,operation,memory_id,input_ref,receipt,state)
   VALUES(tenant_arg,request_arg,actor_arg,'policy-expiry:'||request_arg::text,'DELETE',row_arg.id,NULL,jsonb_build_object('outcome','DELETED','memoryId',row_arg.id,'version',deleted_version_arg,'etag',NULL,'replayed',false),'CONTENT_REMOVED');
  counts=public.oa_purge_private_memory_content(row_arg.id);
  UPDATE public.memory_scope_epochs SET generation=generation+1 WHERE tenant_id=tenant_arg AND owner_id=actor_arg RETURNING generation INTO generation_arg;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMORY_GENERATION_REQUIRED' USING ERRCODE='23514';END IF;
  INSERT INTO public.memory_deletions(tenant_id,id,owner_id,memory_id,generation,revision_count,index_count,request_count,coverage,counts,external_bounds)
   VALUES(tenant_arg,gen_random_uuid(),actor_arg,row_arg.id,generation_arg,(counts->>'revisions')::int,(counts->>'indexes')::int,(counts->>'requests')::int,'RECORDED_DEPENDENCIES',counts,
    jsonb_build_object('cause','POLICY_EXPIRY','alreadyDispatched','Cannot unsend external bytes; UNKNOWN effects/accounting retained.','physicalStorage','Online logical erasure; PostgreSQL/WAL physical zeroization not asserted.','backupRetentionDays',backup_days,'backupReviewReference',review_reference));
  INSERT INTO public.memory_events(tenant_id,id,owner_id,memory_id,outcome,request_id) VALUES(tenant_arg,gen_random_uuid(),actor_arg,row_arg.id,'DELETED',request_arg);
  expired_count=expired_count+1;
 END LOOP;
 SELECT coalesce(array_agg(memory_id ORDER BY created_at,id),'{}'::uuid[]) INTO dirty_ids FROM (
  SELECT d.memory_id,d.created_at,d.id FROM public.memory_deletions d WHERE d.tenant_id=tenant_arg AND d.owner_id=actor_arg AND public.oa_private_memory_dirty(d.memory_id)
  ORDER BY d.created_at,d.id LIMIT limit_arg+1
 ) dirty;
 FOR row_arg IN SELECT unnest(dirty_ids[1:limit_arg]) memory_id LOOP
  PERFORM public.oa_repair_private_memory(row_arg.memory_id);repaired_count=repaired_count+1;
 END LOOP;
 RETURN jsonb_build_object('status','BATCH_APPLIED','expired',expired_count,'repaired',repaired_count,'more',cardinality(expired_ids)>limit_arg OR cardinality(dirty_ids)>limit_arg);
END $$;
REVOKE ALL ON FUNCTION public.oa_maintain_private_preferences(integer,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_maintain_private_preferences(integer,integer,text) TO oa_runtime;
CREATE OR REPLACE FUNCTION public.oa_repair_user_persona_erasure() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;known public.persona_privacy_state%ROWTYPE;
 run_ids uuid[];proposals uuid[];inbox_ids uuid[];dirty boolean;affected bigint;counts jsonb;last_erasure uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=tenant_arg AND u.id=actor_arg) THEN RETURN jsonb_build_object('status','SUBJECT_INACTIVE');END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':persona:USER:'||actor_arg::text,0));
 SELECT * INTO known FROM public.persona_privacy_state WHERE tenant_id=tenant_arg AND owner_id=actor_arg FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','NO_ERASURE');END IF;
 SELECT id INTO last_erasure FROM public.persona_privacy_erasures WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND generation=known.generation AND persona_id=known.persona_id AND through_version=known.through_version;
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
  UNION SELECT u.source_event_id FROM public.source_choice_replies u WHERE u.tenant_id=tenant_arg AND u.owner_id=actor_arg AND u.run_id=ANY(run_ids) AND u.source_event_id IS NOT NULL
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
