CREATE TABLE run_source_choices (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,finalization_id uuid NOT NULL,
 session_no bigint NOT NULL,run_fence bigint NOT NULL,option_count integer NOT NULL CHECK(option_count BETWEEN 2 AND 10),
 payload_ref jsonb NOT NULL,projection_hash text NOT NULL CHECK(projection_hash ~ '^[a-f0-9]{64}$'),answered_at timestamptz,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,run_id,owner_id),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,finalization_id,run_id,owner_id,session_no) REFERENCES run_finalizations(tenant_id,id,run_id,owner_id,session_no)
);
ALTER TABLE run_source_choices ENABLE ROW LEVEL SECURITY;ALTER TABLE run_source_choices FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON run_source_choices USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON run_source_choices TO oa_runtime;GRANT UPDATE(answered_at,updated_at,version) ON run_source_choices TO oa_runtime;
ALTER TABLE runs ADD COLUMN source_choice_id uuid;
ALTER TABLE runs ADD FOREIGN KEY(tenant_id,source_choice_id,id,owner_id) REFERENCES run_source_choices(tenant_id,id,run_id,owner_id);
CREATE TABLE source_choice_replies (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,choice_id uuid NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),input_hash text NOT NULL,option_index integer NOT NULL CHECK(option_index BETWEEN 1 AND 10),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPLIED','CONSUMED','REJECTED')),worker_generation bigint NOT NULL DEFAULT 0,
 answer_ref jsonb NOT NULL,source_event_id uuid,conversation_id uuid,generation bigint,selected_action_id uuid,rejection_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,run_id,owner_id),UNIQUE(tenant_id,owner_id,run_id,request_key),
 FOREIGN KEY(tenant_id,choice_id,run_id,owner_id) REFERENCES run_source_choices(tenant_id,id,run_id,owner_id),
 FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id),
 FOREIGN KEY(tenant_id,selected_action_id) REFERENCES tool_actions(tenant_id,id),
 CHECK((state IN ('APPLIED','CONSUMED'))=(generation IS NOT NULL)),CHECK((state='CONSUMED')=(selected_action_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_source_choice_reply ON source_choice_replies(tenant_id,choice_id) WHERE state='PENDING';
ALTER TABLE source_choice_replies ENABLE ROW LEVEL SECURITY;ALTER TABLE source_choice_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON source_choice_replies USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON source_choice_replies TO oa_runtime;GRANT UPDATE(state,generation,selected_action_id,rejection_code,worker_generation,updated_at,version) ON source_choice_replies TO oa_runtime;
GRANT SELECT(tenant_id,id,owner_id,run_id,state,created_at) ON source_choice_replies TO oa_app;
ALTER TABLE runs ADD COLUMN source_reply_id uuid;
ALTER TABLE runs ADD FOREIGN KEY(tenant_id,source_reply_id,id,owner_id) REFERENCES source_choice_replies(tenant_id,id,run_id,owner_id);
ALTER TABLE dingtalk_clarification_replies ADD COLUMN source_choice_id uuid;
ALTER TABLE dingtalk_clarification_replies ADD FOREIGN KEY(tenant_id,source_choice_id) REFERENCES run_source_choices(tenant_id,id);
ALTER TABLE dingtalk_clarification_replies DROP CONSTRAINT dingtalk_clarification_replies_outcome_check;
ALTER TABLE dingtalk_clarification_replies ADD CHECK(outcome IN ('RESUMED','PENDING_SOURCE_CHECK','NOT_FOUND','AMBIGUOUS','INVALID','GROUP_DENIED','CLOSED'));
