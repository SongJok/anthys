-- The runtime witness is never accepted from an HTTP request. The worker sets
-- it only after a fresh GroupAudience check for the same owner/run/audience.
CREATE OR REPLACE FUNCTION public.oa_persona_authority(kind_arg text,scope_arg text,write_arg boolean) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE
  WHEN kind_arg='USER' AND scope_arg=u.id::text THEN jsonb_build_object('authEpoch',u.auth_epoch)
  WHEN kind_arg='GLOBAL' AND scope_arg=u.tenant_id::text AND NOT write_arg THEN jsonb_build_object('authEpoch',u.auth_epoch)
  WHEN kind_arg='GROUP' AND NOT write_arg AND session_user='oa_runtime' AND EXISTS(
   SELECT 1 FROM public.run_group_audiences q JOIN public.runs r ON r.tenant_id=q.tenant_id AND r.id=q.run_id AND r.owner_id=q.owner_id AND r.group_audience_id=q.id
    JOIN public.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=r.owner_id
   WHERE q.tenant_id=u.tenant_id AND q.owner_id=u.id AND r.id::text=current_setting('app.persona_runtime_run_id',true)
    AND q.expires_at>clock_timestamp() AND t.expires_at>clock_timestamp() AND t.cancel_requested_at IS NULL AND t.status IN ('ACTIVE','COMPLETED')
    AND t.auth_epoch=u.auth_epoch AND t.audience->>'kind'='GROUP' AND t.audience->>'targetId'=scope_arg
  ) THEN jsonb_build_object('authEpoch',u.auth_epoch,'runtimeRead',true)
  ELSE (SELECT jsonb_build_object('authEpoch',u.auth_epoch,'bindingId',b.id,'bindingVersion',b.version)
   FROM public.role_bindings b JOIN public.roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id
   WHERE b.tenant_id=u.tenant_id AND b.subject_id=u.id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
    AND ((kind_arg='GLOBAL' AND scope_arg=u.tenant_id::text AND r.name='TENANT_ADMIN' AND b.scope_kind='TENANT' AND b.scope_id=u.tenant_id::text)
     OR (kind_arg='GROUP' AND r.name=ANY(CASE WHEN write_arg THEN ARRAY['GROUP_ADMIN'] ELSE ARRAY['GROUP_ADMIN','GROUP_MEMBER'] END) AND b.scope_kind='GROUP' AND b.scope_id=scope_arg))
   ORDER BY b.id LIMIT 1) END
 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id
 WHERE u.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND u.id=nullif(current_setting('app.actor_id',true),'')::uuid
  AND u.status='ACTIVE' AND t.status='ACTIVE' AND kind_arg IN ('GLOBAL','GROUP','USER') AND length(scope_arg) BETWEEN 1 AND 512;
$$;
CREATE TABLE run_persona_snapshots (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,task_id uuid NOT NULL,
 proof_ref jsonb NOT NULL,proof_hash text NOT NULL CHECK(proof_hash ~ '^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,run_id),UNIQUE(tenant_id,id,run_id,owner_id),
 FOREIGN KEY(tenant_id,run_id,task_id,owner_id) REFERENCES runs(tenant_id,id,task_id,owner_id),FOREIGN KEY(tenant_id,task_id,owner_id) REFERENCES tasks(tenant_id,id,requester_id)
);
ALTER TABLE run_persona_snapshots ENABLE ROW LEVEL SECURITY;ALTER TABLE run_persona_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY persona_snapshot_owner ON run_persona_snapshots USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON run_persona_snapshots TO oa_runtime;
GRANT UPDATE(revoked_at,updated_at,version) ON run_persona_snapshots TO oa_runtime;
CREATE TABLE run_persona_sources (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,snapshot_id uuid NOT NULL,
 scope_kind text NOT NULL CHECK(scope_kind IN ('GLOBAL','GROUP','USER')),scope_id text NOT NULL,persona_id uuid,revision_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,snapshot_id,scope_kind,scope_id),
 FOREIGN KEY(tenant_id,snapshot_id,run_id,owner_id) REFERENCES run_persona_snapshots(tenant_id,id,run_id,owner_id),
 FOREIGN KEY(tenant_id,revision_id,persona_id) REFERENCES persona_revisions(tenant_id,id,persona_id),
 FOREIGN KEY(tenant_id,persona_id,scope_kind,scope_id) REFERENCES personas(tenant_id,id,scope_kind,scope_id),CHECK((persona_id IS NULL)=(revision_id IS NULL))
);
ALTER TABLE run_persona_sources ENABLE ROW LEVEL SECURITY;ALTER TABLE run_persona_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY persona_source_owner ON run_persona_sources USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON run_persona_sources TO oa_runtime;
ALTER TABLE runs ADD COLUMN persona_snapshot_id uuid;
ALTER TABLE runs ADD COLUMN persona_context_state text NOT NULL DEFAULT 'UNBOUND' CHECK(persona_context_state IN ('LEGACY_NONE','BUILTIN_ONLY','UNBOUND','BOUND'));
UPDATE runs SET persona_context_state='LEGACY_NONE';
ALTER TABLE runs ADD CHECK((persona_snapshot_id IS NOT NULL)=(persona_context_state='BOUND'));
ALTER TABLE runs ADD FOREIGN KEY(tenant_id,persona_snapshot_id,id,owner_id) REFERENCES run_persona_snapshots(tenant_id,id,run_id,owner_id);
CREATE FUNCTION public.oa_run_persona_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.persona_snapshot_id IS NOT NULL AND NEW.persona_snapshot_id IS DISTINCT FROM OLD.persona_snapshot_id OR OLD.persona_context_state IN ('LEGACY_NONE','BUILTIN_ONLY') AND NEW.persona_context_state<>OLD.persona_context_state THEN RAISE EXCEPTION 'PERSONA_SNAPSHOT_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER run_persona_pointer BEFORE UPDATE OF persona_snapshot_id,persona_context_state ON runs FOR EACH ROW EXECUTE FUNCTION public.oa_run_persona_pointer();
