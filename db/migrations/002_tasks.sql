CREATE TABLE conversations (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL,channel text NOT NULL,external_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('DM','GROUP')),classification text NOT NULL DEFAULT 'INTERNAL',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,channel,external_id)
);
CREATE TABLE conversation_members (
 tenant_id uuid NOT NULL,id uuid NOT NULL,conversation_id uuid NOT NULL,user_id uuid NOT NULL,valid_from timestamptz NOT NULL DEFAULT now(),valid_to timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX conversation_members_active ON conversation_members(tenant_id,conversation_id,user_id) WHERE valid_to IS NULL;
CREATE TABLE event_inbox (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,source text NOT NULL,event_key text NOT NULL,payload_cipher_ref text NOT NULL,state text NOT NULL CHECK(state IN ('RECEIVED','ENQUEUED','PROCESSED','DEAD')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source,event_key),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE tasks (
 tenant_id uuid NOT NULL,id uuid NOT NULL,requester_id uuid NOT NULL,conversation_id uuid,source_event_id uuid,goal text NOT NULL,status text NOT NULL CHECK(status IN ('OPEN','ACTIVE','PAUSED','COMPLETED','CANCELLED','EXPIRED')),audience jsonb NOT NULL,auth_epoch bigint NOT NULL,expires_at timestamptz NOT NULL,cancel_requested_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_event_id),FOREIGN KEY(tenant_id,requester_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id)
);
CREATE INDEX tasks_owner_time ON tasks(tenant_id,requester_id,created_at DESC,id);
CREATE TABLE runs (
 tenant_id uuid NOT NULL,id uuid NOT NULL,task_id uuid NOT NULL,owner_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('QUEUED','RUNNING','WAITING_USER','WAITING_AUTH','WAITING_APPROVAL','RETRY_SCHEDULED','VERIFYING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','EXPIRED')),context_ref text,budget jsonb NOT NULL,lease_owner text,lease_until timestamptz,fence bigint NOT NULL DEFAULT 0,model_turns int NOT NULL DEFAULT 0,tool_calls int NOT NULL DEFAULT 0,result text,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX runs_task_time ON runs(tenant_id,task_id,created_at,id);
CREATE TABLE run_steps (
 tenant_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,owner_id uuid NOT NULL,seq bigint NOT NULL,kind text NOT NULL,state text NOT NULL,input_hash text,result_ref text,safe_payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,run_id,seq),FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE outbox (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,kind text NOT NULL,aggregate_id uuid NOT NULL,payload_ref jsonb NOT NULL,dedup_key text NOT NULL,published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,dedup_key),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX outbox_pending ON outbox(tenant_id,owner_id,created_at,id) WHERE published_at IS NULL;
CREATE TABLE deliveries (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,target jsonb NOT NULL,args_hash text NOT NULL,state text NOT NULL CHECK(state IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN','SUPPRESSED')),message_id text,external_request_id text,content_ref text NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,task_id,args_hash),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON conversations,conversation_members,event_inbox,tasks,runs,run_steps,outbox,deliveries TO oa_app,oa_runtime;
REVOKE INSERT,UPDATE,DELETE ON tenants,users,departments,memberships,roles,role_bindings,identities FROM oa_app;
ALTER TABLE event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON event_inbox USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON tasks USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND requester_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND requester_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON runs USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON run_steps USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON outbox USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON deliveries USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON conversation_members USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON conversations USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.tenant_id=conversations.tenant_id AND m.conversation_id=conversations.id AND m.user_id=nullif(current_setting('app.actor_id',true),'')::uuid AND m.valid_to IS NULL)) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
