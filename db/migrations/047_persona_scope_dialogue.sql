ALTER TABLE persona_revisions ADD UNIQUE(tenant_id,id,actor_id);
CREATE TABLE persona_scope_proposals (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,source_event_id uuid NOT NULL,conversation_id uuid NOT NULL,
 external_conversation_id text NOT NULL CHECK(length(external_conversation_id) BETWEEN 1 AND 512),channel_kind text NOT NULL CHECK(channel_kind IN ('DM','GROUP')),
 auth_epoch bigint NOT NULL,proof_ref jsonb,proof_hash text NOT NULL CHECK(proof_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPLIED','REJECTED','CANCELLED','EXPIRED')),
 decision_event_id uuid,applied_revision_id uuid,chosen_scope_kind text,chosen_scope_id text,rejection_code text,closed_at timestamptz,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_event_id),UNIQUE(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,source_event_id,owner_id) REFERENCES event_inbox(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,decision_event_id,owner_id) REFERENCES event_inbox(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,applied_revision_id,owner_id) REFERENCES persona_revisions(tenant_id,id,actor_id),
 CHECK((state='PENDING')=(proof_ref IS NOT NULL)),CHECK((state='PENDING')=(closed_at IS NULL)),
 CHECK((state='APPLIED')=(applied_revision_id IS NOT NULL)),CHECK((state='APPLIED')=(chosen_scope_kind IS NOT NULL)),
 CHECK((chosen_scope_kind IS NULL)=(chosen_scope_id IS NULL)),CHECK(chosen_scope_kind IS NULL OR chosen_scope_kind IN ('USER','GROUP','GLOBAL')),
 CHECK(state<>'APPLIED' OR decision_event_id IS NOT NULL),CHECK(expires_at>created_at)
);
ALTER TABLE persona_scope_proposals ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_scope_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON persona_scope_proposals USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_persona_authority('USER',owner_id::text,false) IS NOT NULL) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_persona_authority('USER',owner_id::text,false) IS NOT NULL);
CREATE FUNCTION public.oa_persona_proposal_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'PENDING' OR NEW.state='PENDING' OR NEW.proof_ref IS NOT NULL THEN RAISE EXCEPTION 'PERSONA_PROPOSAL_IMMUTABLE' USING ERRCODE='23514';END IF;
 NEW.version=OLD.version+1;NEW.updated_at=clock_timestamp();NEW.closed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER persona_proposal_close BEFORE UPDATE ON persona_scope_proposals FOR EACH ROW EXECUTE FUNCTION public.oa_persona_proposal_close();
GRANT SELECT,INSERT ON persona_scope_proposals TO oa_runtime;
GRANT UPDATE(state,proof_ref,decision_event_id,applied_revision_id,chosen_scope_kind,chosen_scope_id,rejection_code,closed_at,version,updated_at) ON persona_scope_proposals TO oa_runtime;
GRANT SELECT(tenant_id,id,owner_id,source_event_id,conversation_id,state,expires_at,created_at,closed_at) ON persona_scope_proposals TO oa_app;
CREATE INDEX persona_proposal_pending ON persona_scope_proposals(tenant_id,owner_id,conversation_id,expires_at) WHERE state='PENDING';
ALTER TABLE persona_control_responses DROP CONSTRAINT persona_control_responses_outcome_check;
ALTER TABLE persona_control_responses ADD CHECK(outcome IN ('SAVED','VIEW','HELP','CLARIFY','DENIED','CONFLICT','LOCKED','UNAVAILABLE','AMBIGUOUS','CANCELLED','EXPIRED','NOT_FOUND'));
ALTER TABLE persona_control_responses ADD COLUMN proposal_id uuid;
ALTER TABLE persona_control_responses ADD COLUMN scope_choices jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(scope_choices)='array');
ALTER TABLE persona_control_responses ADD FOREIGN KEY(tenant_id,proposal_id,owner_id) REFERENCES persona_scope_proposals(tenant_id,id,owner_id);
