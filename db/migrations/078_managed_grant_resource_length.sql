-- PostgreSQL ARE repetition bounds cannot exceed255. Preserve the exact
-- resource alphabet and512-character limit as separate checks. Migration077
-- is already immutable; replace only its known validation expression.
DO $migration$
DECLARE body_arg text=pg_get_functiondef('public.oa_permission_admin_mutate(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)'::regprocedure);
 needle_arg text=$needle$coalesce(args_arg->>'resourceId','')!~'^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,511}$'$needle$;
 replacement_arg text=$replacement$coalesce(args_arg->>'resourceId','')!~'^[A-Za-z0-9][A-Za-z0-9_./:@-]*$' OR length(args_arg->>'resourceId')>512$replacement$;
BEGIN
 IF length(body_arg)-length(replace(body_arg,needle_arg,''))<>length(needle_arg) THEN RAISE EXCEPTION 'MANAGED_GRANT_VALIDATION_SOURCE_MISMATCH';END IF;
 EXECUTE replace(body_arg,needle_arg,replacement_arg);
END $migration$;
