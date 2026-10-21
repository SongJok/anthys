-- These are application roles, not invented DingTalk platform permissions.
-- Grants are provisioned by the trusted tenant administration path.
CREATE FUNCTION public.oa_persona_authority(kind_arg text,scope_arg text,write_arg boolean) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE
  WHEN kind_arg='USER' AND scope_arg=u.id::text THEN jsonb_build_object('authEpoch',u.auth_epoch)
  WHEN kind_arg='GLOBAL' AND scope_arg=u.tenant_id::text AND NOT write_arg THEN jsonb_build_object('authEpoch',u.auth_epoch)
  ELSE (SELECT jsonb_build_object('authEpoch',u.auth_epoch,'bindingId',b.id,'bindingVersion',b.version)
   FROM public.role_bindings b JOIN public.roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id
   WHERE b.tenant_id=u.tenant_id AND b.subject_id=u.id AND b.revoked_at IS NULL
    AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
    AND ((kind_arg='GLOBAL' AND scope_arg=u.tenant_id::text AND r.name='TENANT_ADMIN' AND b.scope_kind='TENANT' AND b.scope_id=u.tenant_id::text)
     OR (kind_arg='GROUP' AND r.name=ANY(CASE WHEN write_arg THEN ARRAY['GROUP_ADMIN'] ELSE ARRAY['GROUP_ADMIN','GROUP_MEMBER'] END)
      AND b.scope_kind='GROUP' AND b.scope_id=scope_arg))
   ORDER BY b.id LIMIT 1) END
 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id
 WHERE u.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND u.id=nullif(current_setting('app.actor_id',true),'')::uuid AND u.status='ACTIVE' AND t.status='ACTIVE'
  AND kind_arg IN ('GLOBAL','GROUP','USER') AND length(scope_arg) BETWEEN 1 AND 512;
$$;
REVOKE ALL ON FUNCTION public.oa_persona_authority(text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_persona_authority(text,text,boolean) TO oa_app,oa_runtime;

CREATE TABLE personas (
 tenant_id uuid NOT NULL,id uuid NOT NULL,scope_kind text NOT NULL CHECK(scope_kind IN ('GLOBAL','GROUP','USER')),scope_id text NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 512),
 current_revision_id uuid,created_by uuid NOT NULL,version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,scope_kind,scope_id),UNIQUE(tenant_id,id,scope_kind,scope_id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id),
 CHECK((version=0)=(current_revision_id IS NULL)),CHECK(scope_kind<>'GLOBAL' OR scope_id=tenant_id::text)
);
CREATE TABLE persona_revisions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,persona_id uuid NOT NULL,scope_kind text NOT NULL,scope_id text NOT NULL,
 version_no bigint NOT NULL CHECK(version_no>0),settings_ref jsonb NOT NULL,settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'),
 actor_id uuid NOT NULL,actor_auth_epoch bigint NOT NULL,authority_id uuid,authority_version bigint,
 source_kind text NOT NULL CHECK(source_kind IN ('H5','DINGTALK_TEXT')),source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 1 AND 512),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,persona_id,version_no),UNIQUE(tenant_id,id,persona_id),
 FOREIGN KEY(tenant_id,persona_id,scope_kind,scope_id) REFERENCES personas(tenant_id,id,scope_kind,scope_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,authority_id) REFERENCES role_bindings(tenant_id,id)
);
ALTER TABLE personas ADD FOREIGN KEY(tenant_id,current_revision_id,id) REFERENCES persona_revisions(tenant_id,id,persona_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION public.oa_persona_revision_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM persona_revisions r WHERE r.tenant_id=NEW.tenant_id AND r.persona_id=NEW.id AND r.id=NEW.current_revision_id AND r.version_no=NEW.version) THEN RAISE EXCEPTION 'PERSONA_REVISION_POINTER_INVALID' USING ERRCODE='23514'; END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER persona_revision_pointer BEFORE UPDATE ON personas FOR EACH ROW EXECUTE FUNCTION public.oa_persona_revision_pointer();
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;ALTER TABLE personas FORCE ROW LEVEL SECURITY;
CREATE POLICY persona_read ON personas FOR SELECT USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_persona_authority(scope_kind,scope_id,false) IS NOT NULL);
CREATE POLICY persona_insert ON personas FOR INSERT WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_persona_authority(scope_kind,scope_id,true) IS NOT NULL);
CREATE POLICY persona_update ON personas FOR UPDATE USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_persona_authority(scope_kind,scope_id,true) IS NOT NULL) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_persona_authority(scope_kind,scope_id,true) IS NOT NULL);
ALTER TABLE persona_revisions ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY persona_revision_read ON persona_revisions FOR SELECT USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_persona_authority(scope_kind,scope_id,false) IS NOT NULL);
CREATE POLICY persona_revision_insert ON persona_revisions FOR INSERT WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_persona_authority(scope_kind,scope_id,true) IS NOT NULL);
GRANT SELECT,INSERT ON personas,persona_revisions TO oa_runtime;
GRANT UPDATE(current_revision_id,version,updated_at) ON personas TO oa_runtime;
GRANT SELECT ON personas TO oa_app;
-- API role cannot read ciphertext or historical preferences directly.
GRANT SELECT(tenant_id,id,persona_id,scope_kind,scope_id,version_no,actor_id,source_kind,created_at) ON persona_revisions TO oa_app;

CREATE TABLE persona_change_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),input_ref jsonb NOT NULL,
 persona_id uuid NOT NULL,revision_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,request_key),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),
 FOREIGN KEY(tenant_id,revision_id,persona_id) REFERENCES persona_revisions(tenant_id,id,persona_id)
);
ALTER TABLE persona_change_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY persona_request_owner ON persona_change_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON persona_change_requests TO oa_runtime;
CREATE TABLE persona_events (
 tenant_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,scope_kind text NOT NULL,scope_id text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('SAVED','REPLAYED','DENIED','CONFLICT','LOCKED')),revision_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,revision_id) REFERENCES persona_revisions(tenant_id,id)
);
ALTER TABLE persona_events ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_events FORCE ROW LEVEL SECURITY;
CREATE POLICY persona_event_owner ON persona_events USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON persona_events TO oa_runtime;GRANT SELECT ON persona_events TO oa_app;
CREATE TABLE persona_policies (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL,fields jsonb NOT NULL,locked_fields jsonb NOT NULL,review_reference text NOT NULL CHECK(length(review_reference)>0),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id)
);
ALTER TABLE persona_policies ENABLE ROW LEVEL SECURITY;ALTER TABLE persona_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY persona_policy_read ON persona_policies USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_persona_authority('GLOBAL',tenant_id::text,false) IS NOT NULL);
GRANT SELECT ON persona_policies TO oa_runtime;
-- Policy installation remains a distinct trusted administration operation.
CREATE FUNCTION public.oa_persona_policy_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.tenants SET policy_version=gen_random_uuid()::text,version=version+1 WHERE tenant_id=coalesce(NEW.tenant_id,OLD.tenant_id);
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' THEN NEW.version=OLD.version+1;NEW.updated_at=clock_timestamp(); END IF;RETURN NEW;
END $$;
CREATE TRIGGER persona_policy_version BEFORE INSERT OR UPDATE OR DELETE ON persona_policies FOR EACH ROW EXECUTE FUNCTION public.oa_persona_policy_version();
REVOKE ALL ON FUNCTION public.oa_persona_policy_version() FROM PUBLIC;
