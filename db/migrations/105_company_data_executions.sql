-- Definitions only. A separately reviewed operator transaction installs any
-- data scope or resource grant; this migration activates no enterprise query.
CREATE TABLE public.company_data_scopes (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,
 connector_id text NOT NULL CHECK(connector_id~'^[A-Za-z0-9._-]{1,128}$'),
 connection_binding text NOT NULL CHECK(connection_binding~'^[a-f0-9]{64}$'),
 template_key text NOT NULL CHECK(template_key~'^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$' AND length(template_key)<=128),
 template_version text NOT NULL CHECK(template_version~'^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
 template_hash text NOT NULL CHECK(template_hash~'^[a-f0-9]{64}$'),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),source_revision text NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
 tool_schema_hash text NOT NULL CHECK(tool_schema_hash~'^[a-f0-9]{64}$'),contract_hash text NOT NULL CHECK(contract_hash~'^[a-f0-9]{64}$'),
 readonly_proof_ref text NOT NULL CHECK(length(readonly_proof_ref) BETWEEN 1 AND 2048),
 actor_resource_review_ref text NOT NULL CHECK(length(actor_resource_review_ref) BETWEEN 1 AND 2048),
 row_scope_review_ref text NOT NULL CHECK(length(row_scope_review_ref) BETWEEN 1 AND 2048),
 row_scope jsonb NOT NULL CHECK(jsonb_typeof(row_scope)='object' AND row_scope<>'{}'::jsonb),
 window_from timestamptz NOT NULL,window_until timestamptz NOT NULL,
 max_window_ms integer NOT NULL CHECK(max_window_ms BETWEEN 1 AND 2678400000),
 classification text NOT NULL CHECK(classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
 model_egress_allowed boolean NOT NULL DEFAULT false,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,connector_id,template_key,template_version),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK(isfinite(window_from) AND isfinite(window_until) AND window_until>window_from AND isfinite(expires_at))
);
ALTER TABLE public.company_data_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_data_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY company_data_owner ON public.company_data_scopes USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON public.company_data_scopes TO oa_runtime;
CREATE TRIGGER company_data_scope_version BEFORE UPDATE ON public.company_data_scopes FOR EACH ROW EXECUTE FUNCTION public.oa_company_scope_version();

-- Retained audit records never store raw parameters, tokens or row data. The
-- parameters hash is a canonical digest over the certified template parameters.
CREATE TABLE public.data_executions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,
 template_key text NOT NULL CHECK(template_key~'^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$' AND length(template_key)<=128),
 template_version text NOT NULL CHECK(template_version~'^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
 params_hash text NOT NULL CHECK(params_hash~'^[a-f0-9]{64}$'),
 query_id uuid,status text NOT NULL CHECK(status IN ('OK','PARTIAL','EMPTY','NEEDS_AUTH','NEEDS_APPROVAL','DENIED','RETRYABLE_ERROR','PERMANENT_ERROR','UNKNOWN')),
 watermark timestamptz,observed_at timestamptz,
 completeness text NOT NULL CHECK(completeness IN ('COMPLETE','TRUNCATED','SAMPLED','UNKNOWN')),
 row_count bigint NOT NULL CHECK(row_count>=0),
 evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 2048),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK(status NOT IN ('OK','PARTIAL','EMPTY') OR (query_id IS NOT NULL AND watermark IS NOT NULL AND observed_at IS NOT NULL AND completeness IN ('COMPLETE','TRUNCATED','SAMPLED'))),
 CHECK(watermark IS NULL OR observed_at IS NULL OR watermark<=observed_at)
);
CREATE INDEX data_executions_owner ON public.data_executions(tenant_id,owner_id,created_at DESC,id);
CREATE INDEX data_executions_template ON public.data_executions(tenant_id,template_key,template_version,created_at DESC);
CREATE INDEX data_executions_query ON public.data_executions(tenant_id,query_id) WHERE query_id IS NOT NULL;
ALTER TABLE public.data_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY data_execution_owner ON public.data_executions USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.data_executions TO oa_runtime;
