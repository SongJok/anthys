CREATE TABLE group_clarification_messages (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,review_id uuid NOT NULL,group_audience_id uuid NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),input_hash text NOT NULL,answer_ref jsonb NOT NULL,
 source_event_id uuid,conversation_id uuid,input_scope text NOT NULL CHECK(input_scope IN ('NATIVE_GROUP','H5_GROUP_ACK')),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPLIED','REJECTED')),worker_generation bigint NOT NULL DEFAULT 0,generation bigint,rejection_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,run_id,owner_id),UNIQUE(tenant_id,owner_id,run_id,request_key),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,review_id) REFERENCES run_narrative_reviews(tenant_id,id),
 FOREIGN KEY(tenant_id,group_audience_id,run_id,owner_id) REFERENCES run_group_audiences(tenant_id,id,run_id,owner_id),
 FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id),
 CHECK((state='APPLIED')=(generation IS NOT NULL)),CHECK((input_scope='NATIVE_GROUP')=(source_event_id IS NOT NULL AND conversation_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_group_answer ON group_clarification_messages(tenant_id,review_id) WHERE state='PENDING';
ALTER TABLE group_clarification_messages ENABLE ROW LEVEL SECURITY;ALTER TABLE group_clarification_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON group_clarification_messages USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON group_clarification_messages TO oa_runtime;GRANT UPDATE(state,worker_generation,generation,rejection_code,updated_at,version) ON group_clarification_messages TO oa_runtime;
GRANT SELECT(tenant_id,id,owner_id,run_id,state,created_at) ON group_clarification_messages TO oa_app;
ALTER TABLE runs ADD COLUMN group_reply_id uuid;
ALTER TABLE runs ADD FOREIGN KEY(tenant_id,group_reply_id,id,owner_id) REFERENCES group_clarification_messages(tenant_id,id,run_id,owner_id);
ALTER TABLE dingtalk_clarification_replies DROP CONSTRAINT dingtalk_clarification_replies_outcome_check;
ALTER TABLE dingtalk_clarification_replies ADD CHECK(outcome IN ('RESUMED','PENDING_SOURCE_CHECK','PENDING_GROUP_CHECK','NOT_FOUND','AMBIGUOUS','INVALID','GROUP_DENIED','CLOSED'));
