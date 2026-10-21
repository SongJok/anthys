-- A restored live lease is insufficient authority after content erasure.
-- Keep opaque run dependencies in the deletion ledger as well as the graph.
ALTER TABLE memory_deletions ADD COLUMN run_ids uuid[] NOT NULL DEFAULT '{}';
CREATE FUNCTION public.oa_memory_deletion_run_ids() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT coalesce(array_agg(DISTINCT s.run_id),'{}'::uuid[]) INTO NEW.run_ids FROM public.run_memory_sources s WHERE s.tenant_id=NEW.tenant_id AND s.owner_id=NEW.owner_id AND s.memory_id=NEW.memory_id;
 RETURN NEW;
END $$;
CREATE TRIGGER memory_deletion_dependencies BEFORE INSERT ON memory_deletions FOR EACH ROW EXECUTE FUNCTION public.oa_memory_deletion_run_ids();
CREATE INDEX memory_erasure_run_ids ON memory_deletions USING gin(run_ids);
CREATE INDEX persona_erasure_run_ids ON persona_privacy_erasures USING gin(run_ids);
CREATE FUNCTION public.oa_run_content_erased(run_arg uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM public.memory_deletions d WHERE d.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND d.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND d.run_ids @> ARRAY[run_arg])
 OR EXISTS(SELECT 1 FROM public.run_memory_sources s JOIN public.memory_deletions d ON d.tenant_id=s.tenant_id AND d.memory_id=s.memory_id AND d.owner_id=s.owner_id WHERE s.run_id=run_arg AND s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND s.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid)
 OR EXISTS(SELECT 1 FROM public.persona_privacy_erasures e WHERE e.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND e.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND e.run_ids @> ARRAY[run_arg])
 OR EXISTS(SELECT 1 FROM public.run_persona_sources s JOIN public.persona_revisions r ON r.tenant_id=s.tenant_id AND r.id=s.revision_id AND r.persona_id=s.persona_id WHERE s.run_id=run_arg AND s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND s.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND s.scope_kind='USER' AND s.scope_id=s.owner_id::text AND (r.privacy_erased_at IS NOT NULL OR r.version_no<=public.oa_user_persona_erasure_cutoff(r.scope_kind,r.scope_id)));
$$;
REVOKE ALL ON FUNCTION public.oa_run_content_erased(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.oa_run_content_erased(uuid) TO oa_runtime;
