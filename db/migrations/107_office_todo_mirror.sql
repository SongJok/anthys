-- Local todos stay distinct from external DingTalk todo ids. The external id,
-- revision and verified snapshot live in separate columns; this table records
-- intent and verification state only and grants no external authority.
CREATE TABLE public.office_todos (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 owner_id uuid NOT NULL,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 256 AND title !~ '[[:cntrl:]]'),
 due_at timestamptz,
 assignee_id uuid,
 completed boolean NOT NULL DEFAULT false,
 external_todo_id uuid,
 external_revision text CHECK(external_revision IS NULL OR char_length(external_revision) BETWEEN 1 AND 256),
 external_snapshot jsonb CHECK(external_snapshot IS NULL OR jsonb_typeof(external_snapshot)='object'),
 sync_state text NOT NULL DEFAULT 'LOCAL_ONLY' CHECK(sync_state IN ('LOCAL_ONLY','LINKED','PENDING','UNKNOWN','CONFLICT')),
 pending_operation text CHECK(pending_operation IN ('UPDATE','CLOSE')),
 pending_snapshot jsonb CHECK(pending_snapshot IS NULL OR jsonb_typeof(pending_snapshot)='object'),
 last_verified_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,owner_id,external_todo_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,assignee_id) REFERENCES public.users(tenant_id,id),
 CHECK((external_todo_id IS NULL)=(external_revision IS NULL)),
 CHECK((external_todo_id IS NULL)=(external_snapshot IS NULL)),
 CHECK((sync_state='LOCAL_ONLY')=(external_todo_id IS NULL)),
 CHECK((pending_operation IS NULL)=(pending_snapshot IS NULL)),
 CHECK(pending_operation IS NULL OR sync_state IN ('PENDING','UNKNOWN'))
);
CREATE INDEX office_todos_owner ON public.office_todos(tenant_id,owner_id,created_at DESC,id);
ALTER TABLE public.office_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_todos FORCE ROW LEVEL SECURITY;
CREATE POLICY office_todo_owner ON public.office_todos USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.office_todos TO oa_runtime;
