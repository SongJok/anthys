-- Keep deletion version authoritative when a trusted restorer replays an old root.
ALTER TABLE memory_deletions ADD COLUMN deleted_version bigint;
UPDATE memory_deletions d SET deleted_version=m.version FROM memory_items m WHERE m.tenant_id=d.tenant_id AND m.id=d.memory_id AND m.owner_id=d.owner_id;
ALTER TABLE memory_deletions ALTER COLUMN deleted_version SET NOT NULL;
ALTER TABLE memory_deletions ADD CHECK(deleted_version>0);
CREATE FUNCTION public.oa_memory_deleted_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_version bigint;
BEGIN
 SELECT version INTO root_version FROM public.memory_items WHERE tenant_id=NEW.tenant_id AND id=NEW.memory_id AND owner_id=NEW.owner_id AND state='DELETED';
 IF root_version IS NULL OR NEW.deleted_version IS NOT NULL AND NEW.deleted_version<>root_version THEN RAISE EXCEPTION 'MEMORY_DELETION_VERSION_INVALID' USING ERRCODE='23514';END IF;
 NEW.deleted_version=root_version;RETURN NEW;
END $$;
CREATE TRIGGER memory_deleted_version BEFORE INSERT ON memory_deletions FOR EACH ROW EXECUTE FUNCTION public.oa_memory_deleted_version();
CREATE TABLE memory_erasure_repairs (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,memory_id uuid NOT NULL,counts jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,memory_id,owner_id) REFERENCES memory_items(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,memory_id) REFERENCES memory_deletions(tenant_id,memory_id)
);
ALTER TABLE memory_erasure_repairs ENABLE ROW LEVEL SECURITY;ALTER TABLE memory_erasure_repairs FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON memory_erasure_repairs USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_memory_owner(owner_id)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_memory_owner(owner_id));
GRANT SELECT,INSERT ON memory_erasure_repairs TO oa_runtime;GRANT SELECT ON memory_erasure_repairs TO oa_app;
CREATE OR REPLACE FUNCTION public.oa_erase_private_memory_content(memory_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 run_ids uuid[];task_ids uuid[];inbox_ids uuid[];affected bigint;counts jsonb='{}';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':memory:'||actor_arg::text,0));
 IF NOT public.oa_memory_owner(actor_arg) OR NOT EXISTS(SELECT 1 FROM public.memory_items WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=memory_arg AND state='DELETED') THEN RAISE EXCEPTION 'MEMORY_ERASURE_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT run_id),'{}'::uuid[]) INTO run_ids FROM public.run_memory_sources WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg;
 PERFORM id FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids) ORDER BY id FOR UPDATE;
 SELECT coalesce(array_agg(DISTINCT task_id),'{}'::uuid[]) INTO task_ids FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids);
 SELECT coalesce(array_agg(DISTINCT event_id),'{}'::uuid[]) INTO inbox_ids FROM (
  SELECT source_reference event_id FROM public.memory_revisions WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND memory_id=memory_arg AND source_kind='DINGTALK_TEXT'
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
