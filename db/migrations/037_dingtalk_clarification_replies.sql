ALTER TABLE tasks ADD COLUMN reply_event_id uuid;
ALTER TABLE tasks ADD FOREIGN KEY(tenant_id,reply_event_id) REFERENCES event_inbox(tenant_id,id);
ALTER TABLE run_user_messages ADD COLUMN source_event_id uuid;
ALTER TABLE run_user_messages ADD FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id);
CREATE TABLE dingtalk_clarification_replies (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,event_id uuid NOT NULL,
 task_id uuid,review_id uuid,
 outcome text NOT NULL CHECK(outcome IN ('RESUMED','NOT_FOUND','AMBIGUOUS','INVALID','GROUP_DENIED','CLOSED')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES event_inbox(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,review_id) REFERENCES run_narrative_reviews(tenant_id,id),
 CHECK(outcome<>'RESUMED' OR task_id IS NOT NULL AND review_id IS NOT NULL)
);
ALTER TABLE dingtalk_clarification_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dingtalk_clarification_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON dingtalk_clarification_replies USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON dingtalk_clarification_replies TO oa_runtime;
