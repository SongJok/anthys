-- A contentless owner/tenant-bound erasure veto must survive departure.
-- Ordinary private-table RLS stays active-only. This returns no bodies or IDs.
CREATE OR REPLACE FUNCTION public.oa_run_content_erased(run_arg uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.memory_deletions d WHERE d.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND d.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND d.run_ids @> ARRAY[run_arg])
 OR EXISTS(SELECT 1 FROM public.run_memory_sources s JOIN public.memory_deletions d ON d.tenant_id=s.tenant_id AND d.memory_id=s.memory_id AND d.owner_id=s.owner_id WHERE s.run_id=run_arg AND s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND s.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid)
 OR EXISTS(SELECT 1 FROM public.persona_privacy_erasures e WHERE e.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND e.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND e.run_ids @> ARRAY[run_arg])
 OR EXISTS(SELECT 1 FROM public.run_persona_sources s JOIN public.persona_revisions r ON r.tenant_id=s.tenant_id AND r.id=s.revision_id AND r.persona_id=s.persona_id WHERE s.run_id=run_arg AND s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND s.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND s.scope_kind='USER' AND s.scope_id=s.owner_id::text AND (r.privacy_erased_at IS NOT NULL OR r.version_no<=public.oa_user_persona_erasure_cutoff(r.scope_kind,r.scope_id)));
$$;
REVOKE ALL ON FUNCTION public.oa_run_content_erased(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.oa_run_content_erased(uuid) TO oa_runtime;
