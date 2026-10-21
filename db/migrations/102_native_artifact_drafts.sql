-- Private native TOOL_DRAFT provenance. No grant, external sender, identity,
-- trial/formal admission, scheduler or deployment is installed by this DDL.
ALTER TABLE public.artifacts
 ADD COLUMN source_mode text NOT NULL DEFAULT 'VERIFIED_TASK_RESULT' CHECK(source_mode IN ('VERIFIED_TASK_RESULT','TOOL_DRAFT')),
 ADD COLUMN source_proof jsonb,
 ADD COLUMN native_action_id uuid,
 ADD CONSTRAINT artifact_native_action FOREIGN KEY(tenant_id,native_action_id) REFERENCES public.tool_actions(tenant_id,id),
 ADD CONSTRAINT artifact_native_action_unique UNIQUE(tenant_id,native_action_id),
 ADD CONSTRAINT artifact_source_mode CHECK(
  (source_mode='VERIFIED_TASK_RESULT' AND source_proof IS NULL AND native_action_id IS NULL)
  OR (source_mode='TOOL_DRAFT' AND ((source_proof IS NOT NULL AND jsonb_typeof(source_proof)='object') OR (source_proof IS NULL AND state IN ('FAILED','REVOKED'))) AND native_action_id IS NOT NULL AND source_verification='UNVERIFIED'));
CREATE FUNCTION public.oa_artifact_provenance_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF ROW(NEW.tenant_id,NEW.id,NEW.owner_id,NEW.task_id,NEW.run_id,NEW.source_session_no,NEW.source_hash,NEW.auth_epoch,NEW.format,NEW.request_key,NEW.request_hash,NEW.storage_key,NEW.classification,NEW.source_verification,NEW.expires_at,NEW.created_at,NEW.source_mode,NEW.native_action_id)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.owner_id,OLD.task_id,OLD.run_id,OLD.source_session_no,OLD.source_hash,OLD.auth_epoch,OLD.format,OLD.request_key,OLD.request_hash,OLD.storage_key,OLD.classification,OLD.source_verification,OLD.expires_at,OLD.created_at,OLD.source_mode,OLD.native_action_id) THEN
  RAISE EXCEPTION 'ARTIFACT_PROVENANCE_IMMUTABLE';
 END IF;
 IF NEW.source_proof IS DISTINCT FROM OLD.source_proof AND NOT (OLD.source_mode='TOOL_DRAFT' AND OLD.source_proof IS NOT NULL AND NEW.source_proof IS NULL AND NEW.state IN ('FAILED','REVOKED')) THEN
  RAISE EXCEPTION 'ARTIFACT_PROOF_IMMUTABLE';
 END IF;
 IF OLD.state IN ('FAILED','REVOKED') AND NEW.state NOT IN ('FAILED','REVOKED') THEN RAISE EXCEPTION 'ARTIFACT_TOMBSTONE_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.oa_artifact_provenance_immutable() FROM PUBLIC;
CREATE TRIGGER artifact_provenance_immutable BEFORE UPDATE ON public.artifacts FOR EACH ROW EXECUTE FUNCTION public.oa_artifact_provenance_immutable();

-- Cancellation and private erasure share these existing task/run updates.
-- A trigger has no caller-supplied target and returns no business data. The
-- definer performs only the exact triggering owner's one-way tombstone update,
-- including inactive-owner repair; application roles receive no new grant.
CREATE FUNCTION public.oa_native_artifact_erasure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_SCHEMA<>'public' THEN RAISE EXCEPTION 'ARTIFACT_ERASURE_TRIGGER_SCOPE';END IF;
 IF TG_TABLE_NAME='tasks' THEN
  IF NEW.cancel_requested_at IS NOT NULL THEN
  UPDATE public.artifacts SET state='REVOKED',source_proof=NULL,updated_at=clock_timestamp()
   WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.requester_id AND task_id=NEW.id AND source_mode='TOOL_DRAFT' AND (state<>'REVOKED' OR source_proof IS NOT NULL);
  END IF;
 ELSIF TG_TABLE_NAME='runs' THEN
  IF NEW.status IN ('CANCELLED','FAILED','EXPIRED') OR NEW.last_error IN ('MEMORY_DELETED','PERSONA_PRIVACY_ERASED') THEN
  UPDATE public.artifacts SET state='REVOKED',source_proof=NULL,updated_at=clock_timestamp()
   WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id AND run_id=NEW.id AND source_mode='TOOL_DRAFT' AND (state<>'REVOKED' OR source_proof IS NOT NULL);
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.oa_native_artifact_erasure() FROM PUBLIC;
CREATE TRIGGER native_artifact_task_erasure AFTER UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.oa_native_artifact_erasure();
CREATE TRIGGER native_artifact_run_erasure AFTER UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.oa_native_artifact_erasure();
