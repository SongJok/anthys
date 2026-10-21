-- A managed READ review must not survive a risk/provider change that reused
-- a logical ID, semantic version and binding hash. Keep legacy grants unchanged.
CREATE FUNCTION public.oa_resource_grant_usable(grant_arg uuid,version_arg text,binding_arg text,input_arg text,provider_arg text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.resource_grants g WHERE g.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND g.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND g.id=grant_arg AND (
  g.managed_capability_version IS NULL OR g.managed_capability_version=version_arg AND g.managed_binding_hash=binding_arg
  AND EXISTS(SELECT 1 FROM public.capability_bindings b JOIN public.permission_manifest_heads h ON h.tenant_id=b.tenant_id AND h.capability_id=b.logical_id AND h.capability_version=b.semantic_version
   JOIN public.permission_manifests m ON m.tenant_id=h.tenant_id AND m.id=h.manifest_id
   WHERE b.tenant_id=g.tenant_id AND b.logical_id=g.capability_id AND b.semantic_version=version_arg AND b.schema_hash=binding_arg AND b.state='READY' AND b.risk<>'FORBIDDEN'
   AND h.manifest_id=g.managed_manifest_id AND m.binding_hash=binding_arg AND m.descriptor->>'inputSchemaHash'=input_arg
   AND m.descriptor->>'risk'=b.risk AND m.descriptor->>'provider'=provider_arg)
 ));
$$;
REVOKE ALL ON FUNCTION public.oa_resource_grant_usable(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_resource_grant_usable(uuid,text,text,text,text) TO oa_app,oa_runtime;
DO $migration$
DECLARE body_arg text=pg_get_functiondef('public.oa_permission_diagnose(uuid,text,uuid,jsonb,boolean)'::regprocedure);
 needle_arg text=$needle$public.oa_resource_grant_usable(g.id,version_arg,runtime_arg->>'bindingHash',runtime_arg->>'inputSchemaHash')$needle$;
 replacement_arg text=$replacement$public.oa_resource_grant_usable(g.id,version_arg,runtime_arg->>'bindingHash',runtime_arg->>'inputSchemaHash',runtime_arg->>'provider')$replacement$;
BEGIN
 IF length(body_arg)-length(replace(body_arg,needle_arg,''))<>length(needle_arg) THEN RAISE EXCEPTION 'MANAGED_GRANT_DIAGNOSTIC_SOURCE_MISMATCH';END IF;
 EXECUTE replace(body_arg,needle_arg,replacement_arg);
END $migration$;
DROP FUNCTION public.oa_resource_grant_usable(uuid,text,text,text);
