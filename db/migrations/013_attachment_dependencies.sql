CREATE TABLE task_attachment_dependencies (
 tenant_id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,attachment_id uuid NOT NULL,sha256 text NOT NULL,classification text NOT NULL,auth_epoch bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,task_id,attachment_id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,attachment_id) REFERENCES attachments(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE ON task_attachment_dependencies TO oa_runtime;GRANT SELECT ON task_attachment_dependencies TO oa_app;
ALTER TABLE task_attachment_dependencies ENABLE ROW LEVEL SECURITY;ALTER TABLE task_attachment_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON task_attachment_dependencies USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
