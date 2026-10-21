-- The independent manifest's authentication mode must be one of the actual
-- registered descriptor modes, before granting or renewing local policy.
DO $migration$
DECLARE body_arg text=pg_get_functiondef('public.oa_permission_admin_mutate(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)'::regprocedure);
 needle_arg text=$q$OR runtime_arg->>'provider' IS DISTINCT FROM m.descriptor->>'provider'$q$;
 replacement_arg text=$q$OR runtime_arg->>'provider' IS DISTINCT FROM m.descriptor->>'provider' OR NOT coalesce((runtime_arg->'authModes') ? (m.descriptor->>'authMode'),false)$q$;
BEGIN
 IF length(body_arg)-length(replace(body_arg,needle_arg,''))<>2*length(needle_arg) THEN RAISE EXCEPTION 'MANAGED_AUTH_MODE_SOURCE_MISMATCH';END IF;
 EXECUTE replace(body_arg,needle_arg,replacement_arg);
END $migration$;
