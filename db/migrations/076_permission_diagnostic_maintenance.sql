-- Scoped metadata maintenance only; no sessions or business grants are created.
CREATE FUNCTION public.oa_permission_cache_maintain(limit_arg integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 expired_arg integer; counters_arg integer;
BEGIN
 IF tenant_arg IS NULL OR actor_arg IS NULL OR limit_arg IS NULL OR limit_arg<1 OR limit_arg>128 THEN
  RAISE EXCEPTION 'PERMISSION_MAINTENANCE_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE tenant_id=tenant_arg AND id=actor_arg) THEN
  RAISE EXCEPTION 'PERMISSION_MAINTENANCE_SCOPE_INVALID' USING ERRCODE='42501';
 END IF;
 -- Inactive employees also need cleanup. This runtime-only entry point does
 -- not require or mint an employee session and never modifies authorization.
 IF NOT pg_try_advisory_xact_lock(hashtextextended(tenant_arg::text||':'||actor_arg::text||':permissions',0)) THEN
  RETURN jsonb_build_object('expired',0,'counters',0,'more',true,'skipped',true);
 END IF;
 WITH candidates AS (
  SELECT id FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND expires_at<=clock_timestamp()
  ORDER BY expires_at,id LIMIT limit_arg FOR UPDATE SKIP LOCKED
 ), removed AS (
  DELETE FROM public.permission_diagnostics d USING candidates c
  WHERE d.tenant_id=tenant_arg AND d.owner_id=actor_arg AND d.id=c.id RETURNING d.id
 ) SELECT count(*)::integer INTO expired_arg FROM removed;
 DELETE FROM public.permission_diagnostic_limits WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND window_started<=clock_timestamp()-interval '1 day';
 GET DIAGNOSTICS counters_arg=ROW_COUNT;
 RETURN jsonb_build_object('expired',expired_arg,'counters',counters_arg,'more',EXISTS(
  SELECT 1 FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND expires_at<=clock_timestamp()
 ),'skipped',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_cache_maintain(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_permission_cache_maintain(integer) TO oa_runtime;
