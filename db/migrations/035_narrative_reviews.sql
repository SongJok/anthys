CREATE TABLE run_narrative_reviews (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,
 session_no bigint NOT NULL CHECK(session_no BETWEEN 1 AND 32),run_fence bigint NOT NULL CHECK(run_fence>0),
 proposal_hash text NOT NULL,scope_hash text NOT NULL,dialogue_hash text NOT NULL,policy_hash text NOT NULL,
 request_id uuid NOT NULL,model_payload_hash text NOT NULL,
 verdict text NOT NULL CHECK(verdict IN ('GENERAL','CLARIFICATION','REJECT')),review_ref jsonb NOT NULL,
 answered_at timestamptz,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,run_id,owner_id),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,request_id,owner_id) REFERENCES quota_ledger(tenant_id,id,owner_id),
 CHECK(proposal_hash ~ '^[a-f0-9]{64}$' AND scope_hash ~ '^[a-f0-9]{64}$' AND dialogue_hash ~ '^[a-f0-9]{64}$' AND policy_hash ~ '^[a-f0-9]{64}$' AND model_payload_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE run_narrative_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_narrative_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON run_narrative_reviews USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON run_narrative_reviews TO oa_runtime;
GRANT UPDATE(answered_at,updated_at,version) ON run_narrative_reviews TO oa_runtime;
CREATE INDEX narrative_review_proposal ON run_narrative_reviews(tenant_id,owner_id,run_id,proposal_hash,created_at);
ALTER TABLE runs ADD COLUMN clarification_review_id uuid;
ALTER TABLE runs ADD FOREIGN KEY(tenant_id,clarification_review_id,id,owner_id) REFERENCES run_narrative_reviews(tenant_id,id,run_id,owner_id);

CREATE TABLE run_user_messages (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,review_id uuid NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,run_id,request_key),
 FOREIGN KEY(tenant_id,review_id,run_id,owner_id) REFERENCES run_narrative_reviews(tenant_id,id,run_id,owner_id)
);
ALTER TABLE run_user_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_user_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON run_user_messages USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON run_user_messages TO oa_runtime;
