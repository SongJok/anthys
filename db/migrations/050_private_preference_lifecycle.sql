-- Private preferences are explicit user content, never a grant or shared fact.
CREATE FUNCTION public.oa_memory_owner(owner_arg uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id
  WHERE u.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
   AND u.id=nullif(current_setting('app.actor_id',true),'')::uuid AND u.id=owner_arg
   AND u.status='ACTIVE' AND t.status='ACTIVE');
$$;
REVOKE ALL ON FUNCTION public.oa_memory_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_memory_owner(uuid) TO oa_app,oa_runtime;
CREATE TABLE memory_scope_epochs (
 tenant_id uuid NOT NULL, id uuid NOT NULL,owner_id uuid NOT NULL,generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE FUNCTION public.oa_memory_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.generation=OLD.generation+1;NEW.version=OLD.version+1;NEW.updated_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER memory_epoch_monotonic BEFORE UPDATE ON memory_scope_epochs FOR EACH ROW EXECUTE FUNCTION public.oa_memory_generation();
CREATE TABLE memory_items (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,scope_kind text NOT NULL DEFAULT 'USER' CHECK(scope_kind='USER'),
 kind text NOT NULL DEFAULT 'PREFERENCE' CHECK(kind='PREFERENCE'),state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DELETED')),
 current_revision_id uuid,deleted_at timestamptz,version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),
 CHECK(state<>'DELETED' OR current_revision_id IS NULL AND deleted_at IS NOT NULL),
 CHECK(state<>'ACTIVE' OR deleted_at IS NULL)
);
CREATE TABLE memory_revisions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,memory_id uuid NOT NULL,owner_id uuid NOT NULL,revision_no bigint NOT NULL CHECK(revision_no>0),
 body_ref jsonb NOT NULL,body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 source_kind text NOT NULL CHECK(source_kind IN ('H5','DINGTALK_TEXT')),source_reference uuid NOT NULL,
 consent_basis text NOT NULL CHECK(consent_basis IN ('EXPLICIT_USER_SAVE','EXPLICIT_USER_CORRECTION')),
 confidence numeric(3,2) NOT NULL CHECK(confidence=1),confidence_basis text NOT NULL CHECK(confidence_basis='USER_ASSERTED_PREFERENCE'),
 sensitivity text NOT NULL CHECK(sensitivity IN ('INTERNAL','CONFIDENTIAL','RESTRICTED')),allow_model boolean NOT NULL DEFAULT false,
 valid_from timestamptz NOT NULL,valid_to timestamptz NOT NULL CHECK(valid_to>valid_from),created_by uuid NOT NULL,actor_auth_epoch bigint NOT NULL,
 supersedes uuid,policy_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,memory_id,revision_no),UNIQUE(tenant_id,id,memory_id,owner_id),
 FOREIGN KEY(tenant_id,memory_id,owner_id) REFERENCES memory_items(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id),
 FOREIGN KEY(tenant_id,supersedes,memory_id,owner_id) REFERENCES memory_revisions(tenant_id,id,memory_id,owner_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(created_by=owner_id)
);
ALTER TABLE memory_items ADD FOREIGN KEY(tenant_id,current_revision_id,id,owner_id) REFERENCES memory_revisions(tenant_id,id,memory_id,owner_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION public.oa_memory_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='DELETED' OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'MEMORY_STATE_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NEW.state='ACTIVE' AND NOT EXISTS(SELECT 1 FROM memory_revisions r WHERE r.tenant_id=NEW.tenant_id AND r.memory_id=NEW.id AND r.owner_id=NEW.owner_id AND r.id=NEW.current_revision_id AND r.revision_no=NEW.version) THEN RAISE EXCEPTION 'MEMORY_REVISION_POINTER_INVALID' USING ERRCODE='23514';END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER memory_pointer BEFORE UPDATE ON memory_items FOR EACH ROW EXECUTE FUNCTION public.oa_memory_pointer();
CREATE TABLE memory_search_index (
 tenant_id uuid NOT NULL,id uuid NOT NULL,memory_id uuid NOT NULL,revision_id uuid NOT NULL,owner_id uuid NOT NULL,
 index_ref jsonb NOT NULL,index_hash text NOT NULL CHECK(index_hash ~ '^[a-f0-9]{64}$'),index_version int NOT NULL CHECK(index_version=1),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,revision_id),
 FOREIGN KEY(tenant_id,revision_id,memory_id,owner_id) REFERENCES memory_revisions(tenant_id,id,memory_id,owner_id) ON DELETE CASCADE
);
CREATE TABLE memory_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
 operation text NOT NULL CHECK(operation IN ('SAVE','CORRECT','DELETE')),memory_id uuid NOT NULL,input_ref jsonb,
 receipt jsonb NOT NULL,state text NOT NULL DEFAULT 'RECORDED' CHECK(state IN ('RECORDED','CONTENT_REMOVED')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,request_key),FOREIGN KEY(tenant_id,memory_id,owner_id) REFERENCES memory_items(tenant_id,id,owner_id),
 CHECK((state='CONTENT_REMOVED')=(input_ref IS NULL))
);
CREATE TABLE memory_events (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,memory_id uuid,
 outcome text NOT NULL CHECK(outcome IN ('SAVED','CORRECTED','DELETED','REPLAYED','DENIED','CONFLICT')),
 revision_no bigint,request_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,memory_id,owner_id) REFERENCES memory_items(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES memory_requests(tenant_id,id)
);
CREATE TABLE memory_deletions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,memory_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),
 revision_count int NOT NULL CHECK(revision_count>=0),index_count int NOT NULL CHECK(index_count>=0),request_count int NOT NULL CHECK(request_count>=0),
 coverage text NOT NULL CHECK(coverage='RECORDED_DEPENDENCIES'),counts jsonb NOT NULL,external_bounds jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,memory_id),FOREIGN KEY(tenant_id,memory_id,owner_id) REFERENCES memory_items(tenant_id,id,owner_id)
);
DO $$ DECLARE table_arg text; BEGIN
 FOREACH table_arg IN ARRAY ARRAY['memory_scope_epochs','memory_items','memory_revisions','memory_search_index','memory_requests','memory_events','memory_deletions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_arg);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_arg);
  EXECUTE format('CREATE POLICY owner_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND public.oa_memory_owner(owner_id)) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND public.oa_memory_owner(owner_id))',table_arg);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON memory_scope_epochs,memory_items,memory_revisions,memory_search_index,memory_requests,memory_events,memory_deletions TO oa_runtime;
GRANT UPDATE(generation) ON memory_scope_epochs TO oa_runtime;
GRANT UPDATE(current_revision_id,state,deleted_at,version) ON memory_items TO oa_runtime;
GRANT UPDATE(input_ref,state,updated_at,version) ON memory_requests TO oa_runtime;
-- Deletion removes content, never tombstones/idempotency/audit metadata.
CREATE POLICY revision_erasure ON memory_revisions AS RESTRICTIVE FOR DELETE USING(EXISTS(SELECT 1 FROM memory_items m WHERE m.tenant_id=memory_revisions.tenant_id AND m.id=memory_revisions.memory_id AND m.state='DELETED'));
GRANT DELETE ON memory_revisions TO oa_runtime;
GRANT SELECT ON memory_items,memory_events,memory_deletions TO oa_app;
GRANT SELECT(tenant_id,id,memory_id,owner_id,revision_no,source_kind,consent_basis,sensitivity,allow_model,valid_from,valid_to,created_by,supersedes,created_at) ON memory_revisions TO oa_app;
CREATE INDEX memory_owner_created ON memory_items(tenant_id,owner_id,created_at DESC,id DESC);
CREATE INDEX memory_validity ON memory_revisions(tenant_id,owner_id,valid_to);

CREATE TABLE run_memory_sources (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,task_id uuid NOT NULL,snapshot_id uuid NOT NULL,
 memory_id uuid NOT NULL,revision_id uuid NOT NULL,revision_hash text NOT NULL CHECK(revision_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,snapshot_id,memory_id),
 FOREIGN KEY(tenant_id,memory_id,owner_id) REFERENCES memory_items(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,run_id,task_id,owner_id) REFERENCES runs(tenant_id,id,task_id,owner_id),
 FOREIGN KEY(tenant_id,snapshot_id,run_id,owner_id) REFERENCES run_persona_snapshots(tenant_id,id,run_id,owner_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id)
);
ALTER TABLE run_memory_sources ENABLE ROW LEVEL SECURITY;ALTER TABLE run_memory_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON run_memory_sources USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_memory_owner(owner_id)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_memory_owner(owner_id));
GRANT SELECT,INSERT ON run_memory_sources TO oa_runtime;GRANT SELECT ON run_memory_sources TO oa_app;
CREATE INDEX memory_dependent_runs ON run_memory_sources(tenant_id,owner_id,memory_id,run_id);

-- Called inside the save/delete transaction after its exact memory tombstone.
-- Explicit predicates are retained even under SECURITY DEFINER. No owner-wide purge.
CREATE FUNCTION public.oa_erase_private_memory_content(memory_arg uuid) RETURNS jsonb
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
