-- An observed watch is bound to one certified aggregate data template scope.
-- The binding is immutable and pins the exact scope version/source revision;
-- it grants no source, model or send authority by itself.
CREATE TABLE public.condition_watch_sources (
 tenant_id uuid NOT NULL,watch_id uuid NOT NULL,owner_id uuid NOT NULL,
 scope_id uuid NOT NULL,scope_version bigint NOT NULL CHECK(scope_version>0),
 connector_id text NOT NULL CHECK(connector_id~'^[A-Za-z0-9._-]{1,128}$'),
 connection_binding text NOT NULL CHECK(connection_binding~'^[a-f0-9]{64}$'),
 tool_name text NOT NULL CHECK(tool_name~'^[A-Za-z0-9_.-]{1,128}$'),
 tool_schema_hash text NOT NULL CHECK(tool_schema_hash~'^[a-f0-9]{64}$'),
 template_key text NOT NULL CHECK(template_key~'^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$' AND length(template_key)<=128),
 template_version text NOT NULL CHECK(template_version~'^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
 template_hash text NOT NULL CHECK(template_hash~'^[a-f0-9]{64}$'),
 metric text NOT NULL CHECK(metric IN ('attempts','successes','successRate')),
 window_seconds integer NOT NULL CHECK(window_seconds BETWEEN 60 AND 2678400),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,watch_id),
 FOREIGN KEY(tenant_id,watch_id) REFERENCES public.condition_watches(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES public.company_data_scopes(tenant_id,id)
);
ALTER TABLE public.condition_watch_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.condition_watch_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY condition_watch_source_owner ON public.condition_watch_sources USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.condition_watch_sources TO oa_runtime;
