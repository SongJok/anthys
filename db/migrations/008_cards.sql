CREATE TABLE card_instances (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,
 out_track_id uuid NOT NULL,template_id text NOT NULL,external_target text NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('PRIVATE_USER','GROUP')),
 state text NOT NULL CHECK(state IN ('NEW','CREATING','ACTIVE','FINALIZED','FAILED','UNKNOWN','SUPPRESSED')),
 desired_content text NOT NULL,desired_version bigint NOT NULL DEFAULT 1,applied_version bigint NOT NULL DEFAULT 0,finalize_requested boolean NOT NULL DEFAULT false,
 stream_state text NOT NULL DEFAULT 'IDLE' CHECK(stream_state IN ('IDLE','SENDING')),sent_version bigint,attempt_id uuid,sending_at timestamptz,next_at timestamptz NOT NULL DEFAULT now(),
 initial_data_ref text NOT NULL,last_error text,external_request_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,task_id),UNIQUE(tenant_id,out_track_id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id)
);
CREATE TABLE card_action_tokens (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,card_id uuid NOT NULL,token_hash text NOT NULL,
 action text NOT NULL CHECK(action='CANCEL'),args_hash text NOT NULL,auth_epoch bigint NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,consumed_session_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,token_hash),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,card_id) REFERENCES card_instances(tenant_id,id),FOREIGN KEY(tenant_id,consumed_session_id) REFERENCES sessions(tenant_id,id)
);
CREATE TABLE card_callback_receipts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,event_key text NOT NULL,card_id uuid NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,event_key),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,card_id) REFERENCES card_instances(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE ON card_instances,card_action_tokens,card_callback_receipts TO oa_runtime;
GRANT SELECT,UPDATE ON card_action_tokens TO oa_app;
GRANT SELECT ON card_instances TO oa_app;
ALTER TABLE card_instances ENABLE ROW LEVEL SECURITY;ALTER TABLE card_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON card_instances USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE card_action_tokens ENABLE ROW LEVEL SECURITY;ALTER TABLE card_action_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON card_action_tokens USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE card_callback_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE card_callback_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON card_callback_receipts USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
