CREATE INDEX model_request_orphans ON quota_ledger(tenant_id,owner_id,run_id) WHERE accounting_version=1 AND dispatch_state IN ('PREPARED','DISPATCHING');
CREATE FUNCTION public.oa_budget_orphan_owners() RETURNS TABLE(owner_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT q.owner_id FROM public.quota_ledger q
 WHERE q.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND q.accounting_version=1 AND q.dispatch_state IN ('PREPARED','DISPATCHING')
 AND NOT EXISTS(SELECT 1 FROM public.runs r WHERE r.tenant_id=q.tenant_id AND r.id=q.run_id AND r.owner_id=q.owner_id AND r.fence=q.run_fence AND r.status='RUNNING' AND r.lease_until>clock_timestamp())
 ORDER BY q.owner_id LIMIT 200;
$$;
REVOKE ALL ON FUNCTION public.oa_budget_orphan_owners() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_budget_orphan_owners() TO oa_runtime;
