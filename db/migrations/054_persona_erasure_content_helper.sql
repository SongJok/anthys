-- Preserve applied migration 053; repair its runtime initializer and empty arrays.
CREATE OR REPLACE FUNCTION public.oa_purge_persona_run_content(run_ids uuid[],reason_arg text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;task_ids uuid[];affected bigint;counts jsonb='{}';
BEGIN
 IF reason_arg<>'PERSONA_PRIVACY_ERASED' OR EXISTS(SELECT 1 FROM unnest(run_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.runs r WHERE r.tenant_id=tenant_arg AND r.owner_id=actor_arg AND r.id=x)) THEN RAISE EXCEPTION 'PERSONA_PURGE_SCOPE_INVALID' USING ERRCODE='42501';END IF;
 PERFORM id FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids) ORDER BY id FOR UPDATE;
 SELECT coalesce(array_agg(DISTINCT task_id),'{}'::uuid[]) INTO task_ids FROM public.runs WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=ANY(run_ids);
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
