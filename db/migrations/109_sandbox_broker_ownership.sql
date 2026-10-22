ALTER TABLE sandbox_broker_jobs ADD COLUMN broker_id text CHECK (broker_id IS NULL OR broker_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$');
CREATE INDEX sandbox_broker_jobs_active_owner ON sandbox_broker_jobs(broker_id) WHERE state IN ('RESERVED','RUNNING');

-- Only the restarting broker may settle its own interrupted rows, across all
-- tenant scopes. Active rows are owner-scoped by RLS, so a tenant-scoped
-- UPDATE cannot perform startup recovery without knowing every tenant first.
CREATE FUNCTION public.oa_sandbox_broker_recover(p_broker_id text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE updated integer;
BEGIN
 IF p_broker_id IS NULL OR p_broker_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' THEN RAISE EXCEPTION 'SANDBOX_BROKER_OWNER_INVALID';END IF;
 UPDATE public.sandbox_broker_jobs SET state='FAILED',failure_code='SANDBOX_JOB_INTERRUPTED',completed_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
 WHERE broker_id=p_broker_id AND state IN ('RESERVED','RUNNING');
 GET DIAGNOSTICS updated=ROW_COUNT;
 RETURN updated;
END $$;
REVOKE ALL ON FUNCTION public.oa_sandbox_broker_recover(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_sandbox_broker_recover(text) TO oa_runtime;
