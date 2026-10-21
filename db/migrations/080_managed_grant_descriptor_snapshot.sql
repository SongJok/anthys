-- Reuse the already implemented complete CapabilityDescriptor digest. Older
-- managed records without this proof remain nonusable until explicit review;
-- ordinary independently installed legacy grants retain their previous gates.
ALTER TABLE public.resource_grants ADD COLUMN managed_descriptor_hash text
 CHECK(managed_descriptor_hash IS NULL OR managed_descriptor_hash~'^[a-f0-9]{64}$');
ALTER TABLE public.resource_grants ADD CONSTRAINT managed_descriptor_scope CHECK(managed_capability_version IS NOT NULL OR managed_descriptor_hash IS NULL);
DO $migration$
DECLARE body_arg text=pg_get_functiondef('public.oa_permission_admin_mutate(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)'::regprocedure);
 needles text[]=ARRAY[
  $q$ IF operation_arg<>'REVOKE' THEN$q$,
  $q$IF g.revoked_at IS NOT NULL OR g.managed_manifest_id IS NULL THEN$q$,
  $q$IF b.id IS NULL OR m.id IS DISTINCT FROM g.managed_manifest_id$q$,
  $q$managed_capability_version,managed_binding_hash,managed_manifest_id)$q$,
  $q$expires_arg,b.semantic_version,b.schema_hash,m.id)$q$,
  $q$managed_manifest_id=m.id,version=version+1$q$
 ];
 replacements text[]=ARRAY[
  $q$ IF operation_arg<>'REVOKE' THEN
  IF coalesce(runtime_arg->>'descriptorHash','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PERMISSION_MANIFEST_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;$q$,
  $q$IF g.revoked_at IS NOT NULL OR g.managed_manifest_id IS NULL OR g.managed_descriptor_hash IS NULL THEN$q$,
  $q$IF b.id IS NULL OR g.managed_descriptor_hash IS DISTINCT FROM runtime_arg->>'descriptorHash' OR m.id IS DISTINCT FROM g.managed_manifest_id$q$,
  $q$managed_capability_version,managed_binding_hash,managed_manifest_id,managed_descriptor_hash)$q$,
  $q$expires_arg,b.semantic_version,b.schema_hash,m.id,runtime_arg->>'descriptorHash')$q$,
  $q$managed_manifest_id=m.id,managed_descriptor_hash=runtime_arg->>'descriptorHash',version=version+1$q$
 ];
 i integer;
BEGIN
 FOR i IN 1..cardinality(needles) LOOP
  IF length(body_arg)-length(replace(body_arg,needles[i],''))<>length(needles[i]) THEN RAISE EXCEPTION 'MANAGED_DESCRIPTOR_MUTATION_SOURCE_MISMATCH';END IF;
  body_arg=replace(body_arg,needles[i],replacements[i]);
 END LOOP;
 EXECUTE body_arg;
 body_arg=pg_get_functiondef('public.oa_permission_admin_resources(uuid,uuid,uuid,uuid)'::regprocedure);
 IF length(body_arg)-length(replace(body_arg,$q$'manifestId',managed_manifest_id,$q$,''))<>length($q$'manifestId',managed_manifest_id,$q$) THEN RAISE EXCEPTION 'MANAGED_DESCRIPTOR_LIST_SOURCE_MISMATCH';END IF;
 EXECUTE replace(body_arg,$q$'manifestId',managed_manifest_id,$q$,$q$'manifestId',managed_manifest_id,'descriptorHash',managed_descriptor_hash,$q$);
 body_arg=pg_get_functiondef('public.oa_permission_diagnose(uuid,text,uuid,jsonb,boolean)'::regprocedure);
 IF length(body_arg)-length(replace(body_arg,$q$runtime_arg->>'inputSchemaHash',runtime_arg->>'provider')$q$,''))<>length($q$runtime_arg->>'inputSchemaHash',runtime_arg->>'provider')$q$) THEN RAISE EXCEPTION 'MANAGED_DESCRIPTOR_DIAGNOSTIC_SOURCE_MISMATCH';END IF;
 EXECUTE replace(body_arg,$q$runtime_arg->>'inputSchemaHash',runtime_arg->>'provider')$q$,$q$runtime_arg->>'inputSchemaHash',runtime_arg->>'descriptorHash')$q$);
END $migration$;
DROP FUNCTION public.oa_resource_grant_usable(uuid,text,text,text,text);
CREATE FUNCTION public.oa_resource_grant_usable(grant_arg uuid,version_arg text,binding_arg text,input_arg text,descriptor_arg text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.resource_grants g WHERE g.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND g.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND g.id=grant_arg AND (
  g.managed_capability_version IS NULL OR g.managed_capability_version=version_arg AND g.managed_binding_hash=binding_arg AND g.managed_descriptor_hash=descriptor_arg
  AND EXISTS(SELECT 1 FROM public.capability_bindings b JOIN public.permission_manifest_heads h ON h.tenant_id=b.tenant_id AND h.capability_id=b.logical_id AND h.capability_version=b.semantic_version
   JOIN public.permission_manifests m ON m.tenant_id=h.tenant_id AND m.id=h.manifest_id
   WHERE b.tenant_id=g.tenant_id AND b.logical_id=g.capability_id AND b.semantic_version=version_arg AND b.schema_hash=binding_arg AND b.state='READY' AND b.risk<>'FORBIDDEN'
   AND h.manifest_id=g.managed_manifest_id AND m.binding_hash=binding_arg AND m.descriptor->>'inputSchemaHash'=input_arg AND m.descriptor->>'risk'=b.risk)
 ));
$$;
REVOKE ALL ON FUNCTION public.oa_resource_grant_usable(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_resource_grant_usable(uuid,text,text,text,text) TO oa_app,oa_runtime;
