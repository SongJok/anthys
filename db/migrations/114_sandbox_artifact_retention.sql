-- Expired sandbox artifacts must lose both bytes and metadata. A sweeper runs
-- without a tenant scope, so claiming and finishing are narrow SECURITY DEFINER
-- functions: only already-expired rows can be claimed, and only a claimed row
-- can be deleted. A failed byte removal leaves the claim in place for retry.
ALTER TABLE public.sandbox_artifacts ADD COLUMN retention_claimed_at timestamptz;
CREATE INDEX sandbox_artifacts_expiry ON public.sandbox_artifacts(expires_at,tenant_id,id);

CREATE FUNCTION public.oa_sandbox_artifact_claim_expired(p_limit integer,p_retry_ms integer)
RETURNS TABLE(out_tenant uuid,out_id uuid,out_key text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'SANDBOX_ARTIFACT_RETENTION_LIMIT_INVALID';END IF;
 IF p_retry_ms IS NULL OR p_retry_ms<60000 OR p_retry_ms>86400000 THEN RAISE EXCEPTION 'SANDBOX_ARTIFACT_RETENTION_RETRY_INVALID';END IF;
 RETURN QUERY
 WITH claimed AS (
  SELECT a.tenant_id,a.id FROM public.sandbox_artifacts a
  WHERE a.expires_at<=clock_timestamp()
    AND (a.retention_claimed_at IS NULL OR a.retention_claimed_at<=clock_timestamp()-make_interval(secs=>p_retry_ms::double precision/1000))
  ORDER BY a.expires_at,a.tenant_id,a.id
  FOR UPDATE SKIP LOCKED LIMIT p_limit
 )
 UPDATE public.sandbox_artifacts a SET retention_claimed_at=clock_timestamp()
 FROM claimed c WHERE a.tenant_id=c.tenant_id AND a.id=c.id
 RETURNING a.tenant_id,a.id,a.storage_key;
END $$;
REVOKE ALL ON FUNCTION public.oa_sandbox_artifact_claim_expired(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_sandbox_artifact_claim_expired(integer,integer) TO oa_runtime;

CREATE FUNCTION public.oa_sandbox_artifact_finish_retention(p_tenant uuid,p_id uuid,p_key text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE removed integer;
BEGIN
 IF p_tenant IS NULL OR p_id IS NULL OR p_key IS NULL THEN RETURN false;END IF;
 DELETE FROM public.sandbox_artifacts
 WHERE tenant_id=p_tenant AND id=p_id AND storage_key=p_key AND retention_claimed_at IS NOT NULL;
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed=1;
END $$;
REVOKE ALL ON FUNCTION public.oa_sandbox_artifact_finish_retention(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_sandbox_artifact_finish_retention(uuid,uuid,text) TO oa_runtime;
