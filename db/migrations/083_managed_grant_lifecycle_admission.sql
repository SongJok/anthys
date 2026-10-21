-- A bounded owner trial/formal API approval does not authorize tenant policy
-- administration. No grant mutation may silently broaden those approvals.
DO $migration$
DECLARE body_arg text=pg_get_functiondef('public.oa_permission_admin_authority(uuid)'::regprocedure);
 needle_arg text=$q$BEGIN
 PERFORM s.id FROM public.sessions$q$;
 replacement_arg text=$q$BEGIN
 IF nullif(current_setting('app.trial_profile_hash',true),'') IS NOT NULL
  OR nullif(current_setting('app.formal_profile_hash',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.one_shot_trials WHERE tenant_id=tenant_arg)
  OR EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=tenant_arg)
 THEN RAISE EXCEPTION 'PERMISSION_ADMIN_LIFECYCLE_BLOCKED' USING ERRCODE='42501';END IF;
 PERFORM s.id FROM public.sessions$q$;
BEGIN
 IF length(body_arg)-length(replace(body_arg,needle_arg,''))<>length(needle_arg) THEN RAISE EXCEPTION 'MANAGED_LIFECYCLE_SOURCE_MISMATCH';END IF;
 EXECUTE replace(body_arg,needle_arg,replacement_arg);
END $migration$;
