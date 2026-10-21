ALTER TABLE runs ADD COLUMN model_attempts bigint NOT NULL DEFAULT 0 CHECK(model_attempts>=0);
ALTER TABLE quota_ledger ADD COLUMN accounting_version integer NOT NULL DEFAULT 0 CHECK(accounting_version IN (0,1)),ADD COLUMN attempt_no bigint,ADD COLUMN run_fence bigint,ADD COLUMN dispatch_state text CHECK(dispatch_state IN ('PREPARED','DISPATCHING','COMPLETE','UNKNOWN','RELEASED')),ADD COLUMN token_state text CHECK(token_state IN ('RESERVED','SETTLED','UNKNOWN','RELEASED')),ADD COLUMN reserved_tokens bigint CHECK(reserved_tokens>=0),ADD COLUMN used_tokens bigint CHECK(used_tokens>=0),ADD COLUMN input_bound bigint,ADD COLUMN output_bound bigint,ADD COLUMN policy_hash text,ADD COLUMN policy_snapshot jsonb,ADD COLUMN payload_hash text,ADD COLUMN currency text,ADD COLUMN usage_hash text,ADD COLUMN billing_basis text,ADD COLUMN failure_code text;
ALTER TABLE quota_ledger ADD UNIQUE(tenant_id,id,owner_id),ADD FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id);
CREATE UNIQUE INDEX model_request_attempt ON quota_ledger(tenant_id,run_id,attempt_no) WHERE accounting_version=1;
CREATE TABLE budget_policies (
 tenant_id uuid NOT NULL PRIMARY KEY REFERENCES tenants(tenant_id),id uuid NOT NULL UNIQUE CHECK(id=tenant_id),policy_hash text NOT NULL,document jsonb NOT NULL,currency text NOT NULL CHECK(currency IN ('CNY','USD')),valid_until timestamptz NOT NULL,blocked_reason text CHECK(blocked_reason IS NULL OR blocked_reason='PROVIDER_USAGE_OUTSIDE_RESERVATION'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1
);
CREATE TABLE budget_buckets (
 tenant_id uuid NOT NULL,id uuid NOT NULL,scope_kind text NOT NULL CHECK(scope_kind IN ('TENANT','DEPARTMENT','USER','TASK')),scope_id text NOT NULL,period text NOT NULL,currency text NOT NULL CHECK(currency IN ('CNY','USD')),
 limit_tokens bigint NOT NULL CHECK(limit_tokens>=0),limit_money numeric(30,12) NOT NULL CHECK(limit_money>=0 AND limit_money<=999999999999999999.999999999999),reserved_tokens bigint NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0),used_tokens bigint NOT NULL DEFAULT 0 CHECK(used_tokens>=0),reserved_money numeric(30,12) NOT NULL DEFAULT 0 CHECK(reserved_money>=0 AND reserved_money<=999999999999999999.999999999999),used_money numeric(30,12) NOT NULL DEFAULT 0 CHECK(used_money>=0 AND used_money<=999999999999999999.999999999999),policy_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,scope_kind,scope_id,period,currency),FOREIGN KEY(tenant_id) REFERENCES tenants(tenant_id)
);
CREATE TABLE budget_allocations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,request_id uuid NOT NULL,bucket_id uuid NOT NULL,reserved_tokens bigint NOT NULL CHECK(reserved_tokens>=0),reserved_money numeric(30,12) NOT NULL CHECK(reserved_money>=0 AND reserved_money<=999999999999999999.999999999999),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,bucket_id),FOREIGN KEY(tenant_id,request_id,owner_id) REFERENCES quota_ledger(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,bucket_id) REFERENCES budget_buckets(tenant_id,id)
);
REVOKE SELECT ON quota_ledger FROM oa_app;
GRANT SELECT(tenant_id,id,owner_id,run_id,subject,period,reservation,used,cost_state,created_at,updated_at,version,accounting_version,reserved_tokens,used_tokens,token_state,currency,dispatch_state,attempt_no,failure_code) ON quota_ledger TO oa_app;
GRANT SELECT,INSERT ON budget_policies TO oa_runtime;
GRANT SELECT,INSERT,UPDATE ON budget_buckets TO oa_runtime;
GRANT SELECT,INSERT ON budget_allocations TO oa_runtime;
ALTER TABLE budget_policies ENABLE ROW LEVEL SECURITY;ALTER TABLE budget_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_buckets ENABLE ROW LEVEL SECURITY;ALTER TABLE budget_buckets FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_allocations ENABLE ROW LEVEL SECURITY;ALTER TABLE budget_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON budget_policies USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY isolation ON budget_buckets USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY isolation ON budget_allocations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE FUNCTION public.oa_budget_live_count(bucket_arg uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT count(*) FROM public.budget_allocations a JOIN public.quota_ledger q ON q.tenant_id=a.tenant_id AND q.id=a.request_id AND q.owner_id=a.owner_id JOIN public.runs r ON r.tenant_id=q.tenant_id AND r.id=q.run_id AND r.owner_id=q.owner_id
 WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.bucket_id=bucket_arg AND q.accounting_version=1 AND q.dispatch_state IN ('PREPARED','DISPATCHING') AND r.fence=q.run_fence AND r.status='RUNNING' AND r.lease_until>clock_timestamp();
$$;
CREATE FUNCTION public.oa_budget_has_legacy(start_arg timestamptz,end_arg timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.quota_ledger WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND accounting_version=0 AND cost_state<>'RELEASED' AND created_at>=start_arg AND created_at<end_arg);
$$;
REVOKE ALL ON FUNCTION public.oa_budget_live_count(uuid),public.oa_budget_has_legacy(timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_budget_live_count(uuid),public.oa_budget_has_legacy(timestamptz,timestamptz) TO oa_runtime;
CREATE FUNCTION public.oa_budget_block() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 UPDATE public.budget_policies SET blocked_reason='PROVIDER_USAGE_OUTSIDE_RESERVATION',version=version+1,updated_at=now() WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
$$;
REVOKE ALL ON FUNCTION public.oa_budget_block() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_budget_block() TO oa_runtime;
CREATE INDEX model_request_pending ON quota_ledger(tenant_id,owner_id,run_id,dispatch_state) WHERE accounting_version=1;
ALTER TABLE quota_ledger ADD CHECK((accounting_version=0 OR (attempt_no>0 AND run_fence>0 AND dispatch_state IS NOT NULL AND token_state IS NOT NULL AND reserved_tokens>0 AND input_bound>0 AND output_bound>0 AND policy_hash IS NOT NULL AND policy_snapshot IS NOT NULL AND payload_hash IS NOT NULL AND currency IN ('CNY','USD') AND reservation>0 AND reservation<1000000000000000000 AND (cost_state<>'SETTLED' OR used IS NOT NULL AND used>=0 AND used<=reservation) AND (token_state<>'SETTLED' OR used_tokens IS NOT NULL AND used_tokens<=reserved_tokens))) IS TRUE);
CREATE UNIQUE INDEX model_single_live_request ON quota_ledger(tenant_id,run_id) WHERE accounting_version=1 AND dispatch_state IN ('PREPARED','DISPATCHING');
CREATE FUNCTION public.oa_budget_policy_state() RETURNS TABLE(policy_hash text,currency text,blocked_reason text,valid boolean) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT b.policy_hash,b.currency,b.blocked_reason,b.valid_until>clock_timestamp() FROM public.budget_policies b WHERE b.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR SHARE OF b;
$$;
REVOKE ALL ON FUNCTION public.oa_budget_policy_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_budget_policy_state() TO oa_runtime;
