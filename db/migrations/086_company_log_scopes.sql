-- Definitions only. Independent operator/provider review is required before
-- any source scope is installed. No real log authority is activated here.
CREATE TABLE public.company_log_scopes (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,
 connector_id text NOT NULL CHECK(connector_id~'^[A-Za-z0-9._-]{1,128}$'),
 connection_binding text NOT NULL CHECK(connection_binding~'^[a-f0-9]{64}$'),
 service text NOT NULL CHECK(service~'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
 environment text NOT NULL CHECK(environment IN ('TEST','STAGING','PRODUCTION')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),source_revision text NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
 tool_schema_hash text NOT NULL CHECK(tool_schema_hash~'^[a-f0-9]{64}$'),contract_hash text NOT NULL CHECK(contract_hash~'^[a-f0-9]{64}$'),
 readonly_proof_ref text NOT NULL CHECK(length(readonly_proof_ref) BETWEEN 1 AND 2048),
 authorization_proof_ref text NOT NULL CHECK(length(authorization_proof_ref) BETWEEN 1 AND 2048),
 redaction_policy_ref text NOT NULL CHECK(length(redaction_policy_ref) BETWEEN 1 AND 2048),
 window_from timestamptz NOT NULL,window_until timestamptz NOT NULL,
 max_window_ms integer NOT NULL CHECK(max_window_ms BETWEEN 1 AND 86400000),max_rows integer NOT NULL CHECK(max_rows BETWEEN 1 AND 100),
 allowed_fields text[] NOT NULL CHECK(allowed_fields @> ARRAY['id','timestamp','level','message'] AND allowed_fields <@ ARRAY['id','timestamp','level','message','traceId'] AND cardinality(allowed_fields) BETWEEN 4 AND 5),
 classification text NOT NULL CHECK(classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
 model_egress_allowed boolean NOT NULL DEFAULT false,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,connector_id,service,environment),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK(isfinite(window_from) AND isfinite(window_until) AND window_until>window_from AND isfinite(expires_at))
);
ALTER TABLE public.company_log_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_log_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY company_log_owner ON public.company_log_scopes USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON public.company_log_scopes TO oa_runtime;
CREATE TRIGGER company_log_scope_version BEFORE UPDATE ON public.company_log_scopes FOR EACH ROW EXECUTE FUNCTION public.oa_company_scope_version();
