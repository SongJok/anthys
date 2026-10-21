-- Preserve migration047; strengthen the exact decision write boundary.
CREATE OR REPLACE FUNCTION public.oa_persona_proposal_close() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority jsonb;
BEGIN
 IF OLD.state<>'PENDING' OR NEW.state='PENDING' OR NEW.proof_ref IS NOT NULL THEN RAISE EXCEPTION 'PERSONA_PROPOSAL_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NEW.state='APPLIED' THEN
  IF OLD.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PERSONA_PROPOSAL_EXPIRED' USING ERRCODE='23514';END IF;
  authority=public.oa_persona_authority(NEW.chosen_scope_kind,NEW.chosen_scope_id,true);
  IF authority IS NULL OR (authority->>'authEpoch')::bigint<>OLD.auth_epoch THEN RAISE EXCEPTION 'PERSONA_PROPOSAL_AUTHORITY_CHANGED' USING ERRCODE='23514';END IF;
 END IF;
 NEW.version=OLD.version+1;NEW.updated_at=clock_timestamp();NEW.closed_at=clock_timestamp();RETURN NEW;
END $$;
