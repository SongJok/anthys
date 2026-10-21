-- Descriptors and local diagnostics never grant platform/resource authority.
REVOKE INSERT,UPDATE,DELETE ON public.roles,public.role_bindings FROM oa_runtime;
REVOKE INSERT,UPDATE,DELETE ON public.resource_grants FROM oa_app,oa_runtime;

CREATE TABLE permission_manifests (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL,
 capability_id text NOT NULL,capability_version text NOT NULL,manifest_version integer NOT NULL CHECK(manifest_version>0),
 binding_hash text NOT NULL CHECK(binding_hash~'^[a-f0-9]{64}$'),descriptor_hash text NOT NULL CHECK(descriptor_hash~'^[a-f0-9]{64}$'),
 descriptor jsonb NOT NULL CHECK(jsonb_typeof(descriptor)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,capability_id,capability_version,manifest_version)
);
CREATE TABLE permission_manifest_heads (
 tenant_id uuid NOT NULL,capability_id text NOT NULL,capability_version text NOT NULL,manifest_id uuid NOT NULL,
 version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,capability_id,capability_version),FOREIGN KEY(tenant_id,manifest_id) REFERENCES permission_manifests(tenant_id,id)
);
CREATE TABLE permission_diagnostics (
 tenant_id uuid NOT NULL,owner_id uuid NOT NULL,id uuid NOT NULL,cache_key text NOT NULL CHECK(cache_key~'^[a-f0-9]{64}$'),
 capability_id text NOT NULL,capability_version text NOT NULL,resource_hash text NOT NULL,auth_epoch bigint NOT NULL,
 result jsonb NOT NULL,checked_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,cache_key),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE permission_events (
 tenant_id uuid NOT NULL,owner_id uuid NOT NULL,id uuid NOT NULL,seq bigint GENERATED ALWAYS AS IDENTITY,
 kind text NOT NULL CHECK(kind IN ('ROLE_WITHDRAWN','RESOURCE_WITHDRAWN')),subject_id uuid NOT NULL,subject_version bigint NOT NULL,
 previous_hash text,hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE permission_manifests ENABLE ROW LEVEL SECURITY;ALTER TABLE permission_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE permission_manifest_heads ENABLE ROW LEVEL SECURITY;ALTER TABLE permission_manifest_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE permission_diagnostics ENABLE ROW LEVEL SECURITY;ALTER TABLE permission_diagnostics FORCE ROW LEVEL SECURITY;
ALTER TABLE permission_events ENABLE ROW LEVEL SECURITY;ALTER TABLE permission_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON permission_manifests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_read ON permission_manifest_heads USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY owner_read ON permission_diagnostics USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY owner_read ON permission_events USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON permission_manifests,permission_manifest_heads,permission_diagnostics,permission_events TO oa_app,oa_runtime;

CREATE FUNCTION public.oa_permission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PERMISSION_RECORD_IMMUTABLE' USING ERRCODE='23514';END $$;
REVOKE ALL ON FUNCTION public.oa_permission_immutable() FROM PUBLIC;
CREATE TRIGGER immutable_manifest BEFORE UPDATE OR DELETE ON permission_manifests FOR EACH ROW EXECUTE FUNCTION public.oa_permission_immutable();
CREATE TRIGGER immutable_permission_event BEFORE UPDATE OR DELETE ON permission_events FOR EACH ROW EXECUTE FUNCTION public.oa_permission_immutable();
CREATE FUNCTION public.oa_permission_head() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE next_version integer;prior_version integer;
BEGIN
 SELECT manifest_version INTO next_version FROM public.permission_manifests WHERE tenant_id=NEW.tenant_id AND id=NEW.manifest_id AND capability_id=NEW.capability_id AND capability_version=NEW.capability_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'PERMISSION_MANIFEST_TARGET_MISMATCH' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.capability_id,NEW.capability_version) IS DISTINCT FROM (OLD.tenant_id,OLD.capability_id,OLD.capability_version) THEN RAISE EXCEPTION 'PERMISSION_MANIFEST_TARGET_IMMUTABLE' USING ERRCODE='23514';END IF;
  SELECT manifest_version INTO prior_version FROM public.permission_manifests WHERE tenant_id=OLD.tenant_id AND id=OLD.manifest_id;
  IF next_version<=prior_version THEN RAISE EXCEPTION 'PERMISSION_MANIFEST_ROLLBACK' USING ERRCODE='23514';END IF;
  NEW.version=OLD.version+1;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_head() FROM PUBLIC;
CREATE TRIGGER current_manifest_version BEFORE INSERT OR UPDATE ON permission_manifest_heads FOR EACH ROW EXECUTE FUNCTION public.oa_permission_head();

CREATE FUNCTION public.oa_permission_session(session_arg uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=u.tenant_id
 WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND s.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND s.id=session_arg
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_epoch=u.auth_epoch AND u.status='ACTIVE' AND t.status='ACTIVE');
$$;
REVOKE ALL ON FUNCTION public.oa_permission_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_permission_session(uuid) TO oa_app,oa_runtime;

CREATE FUNCTION public.oa_permission_diagnose(grant_arg uuid,version_arg text,session_arg uuid,runtime_arg jsonb,force_arg boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 g public.resource_grants%ROWTYPE;b public.capability_bindings%ROWTYPE;m public.permission_manifests%ROWTYPE;u public.users%ROWTYPE;t public.tenants%ROWTYPE;d public.dws_identities%ROWTYPE;
 grant_state text;manifest_state text;identity_state text;runtime_state text;reason text;local_state text;identity_ref uuid;
 snapshot jsonb;cache_key_arg text;prior public.permission_diagnostics%ROWTYPE;result_arg jsonb;checked timestamptz;
BEGIN
 IF NOT public.oa_permission_session(session_arg) THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 IF version_arg IS NULL OR length(version_arg)>64 OR version_arg!~'^[0-9]+\.[0-9]+\.[0-9]+$' OR runtime_arg IS NULL OR jsonb_typeof(runtime_arg)<>'object' OR force_arg IS NULL THEN RAISE EXCEPTION 'PERMISSION_DIAGNOSTIC_INPUT_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO t FROM public.tenants WHERE tenant_id=tenant_arg FOR SHARE;
 SELECT * INTO g FROM public.resource_grants WHERE tenant_id=tenant_arg AND actor_id=actor_arg AND id=grant_arg FOR SHARE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO u FROM public.users WHERE tenant_id=tenant_arg AND id=actor_arg FOR SHARE;
 SELECT * INTO b FROM public.capability_bindings WHERE tenant_id=tenant_arg AND logical_id=g.capability_id AND semantic_version=version_arg FOR SHARE;
 SELECT x.* INTO m FROM public.permission_manifest_heads h JOIN public.permission_manifests x ON x.tenant_id=h.tenant_id AND x.id=h.manifest_id WHERE h.tenant_id=tenant_arg AND h.capability_id=g.capability_id AND h.capability_version=version_arg FOR SHARE OF h;
 IF m.descriptor->>'provider'='DWS' THEN SELECT * INTO d FROM public.dws_identities WHERE tenant_id=tenant_arg AND owner_id=actor_arg FOR SHARE;END IF;
 grant_state=CASE WHEN g.revoked_at IS NOT NULL THEN 'REVOKED' WHEN g.expires_at<=clock_timestamp() THEN 'EXPIRED' WHEN g.classification_ceiling NOT IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED') THEN 'CLASSIFICATION_UNCERTIFIED' WHEN g.audience_kind<>'PRIVATE_USER' OR g.audience_id<>actor_arg::text THEN 'AUDIENCE_UNCERTIFIED' ELSE 'ACTIVE' END;
 manifest_state=CASE WHEN m.id IS NULL THEN 'UNCONFIGURED' WHEN m.binding_hash IS DISTINCT FROM b.schema_hash OR m.descriptor->>'risk' IS DISTINCT FROM b.risk OR m.descriptor->>'provider' IS DISTINCT FROM runtime_arg->>'provider' OR m.descriptor->>'inputSchemaHash' IS DISTINCT FROM runtime_arg->>'inputSchemaHash' THEN 'BINDING_MISMATCH' ELSE 'MATCHED' END;
 runtime_state=CASE WHEN runtime_arg->>'id' IS DISTINCT FROM g.capability_id OR runtime_arg->>'version' IS DISTINCT FROM version_arg OR runtime_arg->>'state' IS DISTINCT FROM 'READY' THEN 'UNAVAILABLE' WHEN runtime_arg->>'bindingHash' IS DISTINCT FROM b.schema_hash OR runtime_arg->>'risk' IS DISTINCT FROM b.risk THEN 'BINDING_MISMATCH' ELSE 'READY' END;
 identity_ref=actor_arg;identity_state='LOCAL_BOUND';
 IF m.descriptor->>'provider'='DWS' THEN
  identity_ref=d.id;identity_state=CASE WHEN d.id IS NULL OR d.state<>'CONNECTED' OR d.delegation_expires_at<=clock_timestamp() OR d.auth_epoch<>u.auth_epoch OR NOT d.model_egress_allowed THEN 'USER_CONSENT_REQUIRED' WHEN d.corp_id<>t.corp_id OR d.external_user_id<>u.external_user_id THEN 'IDENTITY_MISMATCH' ELSE 'LOCAL_BOUND' END;
 END IF;
 reason=CASE WHEN grant_state<>'ACTIVE' THEN 'RESOURCE_DENIED' WHEN identity_state<>'LOCAL_BOUND' THEN identity_state WHEN manifest_state<>'MATCHED' OR runtime_state<>'READY' OR b.state IS DISTINCT FROM 'READY' OR b.risk='FORBIDDEN' THEN 'CAPABILITY_NOT_AVAILABLE' ELSE 'UNKNOWN' END;
 local_state=CASE WHEN reason='UNKNOWN' THEN 'MATCHED' ELSE 'BLOCKED' END;
 -- Credential bytes and provider_binding never enter the snapshot, cache or API.
 snapshot=jsonb_build_object('tenant',tenant_arg,'owner',actor_arg,'app',m.descriptor->>'applicationRef','identity',identity_ref,'authEpoch',u.auth_epoch,'policy',t.policy_version,
 'grant',jsonb_build_object('id',g.id,'version',g.version,'resource',g.resource_id,'audience',g.audience_kind,'target',g.audience_id,'membership',g.membership_version,'classification',g.classification_ceiling,'expiry',g.expires_at,'revoked',g.revoked_at,'state',grant_state),
 'binding',jsonb_build_object('id',b.id,'version',b.version,'hash',b.schema_hash,'risk',b.risk,'state',b.state),
 'manifest',jsonb_build_object('id',m.id,'hash',m.descriptor_hash,'version',m.manifest_version,'state',manifest_state),'runtime',runtime_arg,'identityState',identity_state,
 'dws',jsonb_build_object('id',d.id,'authEpoch',d.auth_epoch,'authorizationVersion',d.authorization_version,'credentialVersion',d.credential_version,'state',d.state,'expiry',d.delegation_expires_at,'modelEgress',d.model_egress_allowed,'binary',d.binary_hash));
 cache_key_arg=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND cache_key=cache_key_arg;
 IF NOT force_arg AND FOUND AND prior.expires_at>clock_timestamp() THEN
  IF NOT public.oa_permission_session(session_arg) THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
  IF prior.expires_at<=clock_timestamp() OR grant_state='ACTIVE' AND g.expires_at<=clock_timestamp() OR m.descriptor->>'provider'='DWS' AND identity_state='LOCAL_BOUND' AND d.delegation_expires_at<=clock_timestamp() THEN RETURN public.oa_permission_diagnose(grant_arg,version_arg,session_arg,runtime_arg,true);END IF;
  RETURN prior.result||jsonb_build_object('fromCache',true);
 END IF;
 checked=clock_timestamp();result_arg=jsonb_build_object('grantId',g.id,'capabilityId',g.capability_id,'capabilityVersion',version_arg,'manifestVersion',m.manifest_version,'applicationRef',m.descriptor->>'applicationRef','description',m.descriptor->>'description','overall',CASE WHEN reason='UNKNOWN' THEN 'UNKNOWN' ELSE 'DENIED' END,
 'requiredScopes',coalesce(m.descriptor->'requiredScopes','[]'::jsonb),'resourcePreconditions',coalesce(m.descriptor->'resourcePreconditions','[]'::jsonb),'officialDocRefs',coalesce(m.descriptor->'officialDocRefs','[]'::jsonb),
 'localState',local_state,'reason',reason,'checks',jsonb_build_object('manifest',manifest_state,'binding',coalesce(b.state,'UNCONFIGURED'),'grant',grant_state,'identity',identity_state,'runtime',runtime_state),
 'external',jsonb_build_object('state','UNKNOWN','reason','NO_CERTIFIED_PROBE','live',false),'checkedAt',checked,'expiresAt',checked+interval '30 seconds','cacheKey',cache_key_arg,'fromCache',false,'executionAuthority',false);
 INSERT INTO public.permission_diagnostics(tenant_id,owner_id,id,cache_key,capability_id,capability_version,resource_hash,auth_epoch,result,checked_at,expires_at)
 VALUES(tenant_arg,actor_arg,gen_random_uuid(),cache_key_arg,g.capability_id,version_arg,encode(sha256(convert_to(g.resource_id,'UTF8')),'hex'),u.auth_epoch,result_arg,checked,checked+interval '30 seconds')
 ON CONFLICT(tenant_id,owner_id,cache_key) DO UPDATE SET result=excluded.result,checked_at=excluded.checked_at,expires_at=excluded.expires_at,version=permission_diagnostics.version+1;
 IF NOT public.oa_permission_session(session_arg) THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 IF grant_state='ACTIVE' AND g.expires_at<=clock_timestamp() OR m.descriptor->>'provider'='DWS' AND identity_state='LOCAL_BOUND' AND d.delegation_expires_at<=clock_timestamp() THEN RETURN public.oa_permission_diagnose(grant_arg,version_arg,session_arg,runtime_arg,true);END IF;
 RETURN result_arg;
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_diagnose(uuid,text,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_permission_diagnose(uuid,text,uuid,jsonb,boolean) TO oa_app,oa_runtime;

CREATE FUNCTION public.oa_permission_withdraw(kind_arg text,id_arg uuid,version_arg bigint,session_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 current_version bigint;revoked timestamptz;next_version bigint;event_kind text;prior_hash text;event_id uuid=gen_random_uuid();digest text;
BEGIN
 IF kind_arg IS NULL OR kind_arg NOT IN ('ROLE','RESOURCE') OR version_arg IS NULL OR version_arg<1 THEN RAISE EXCEPTION 'PERMISSION_WITHDRAW_INPUT_INVALID' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':'||actor_arg::text||':permissions',0));
 PERFORM id FROM public.sessions WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id=session_arg FOR SHARE;
 IF NOT public.oa_permission_session(session_arg) THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 IF kind_arg='ROLE' THEN
  SELECT version,revoked_at INTO current_version,revoked FROM public.role_bindings WHERE tenant_id=tenant_arg AND subject_id=actor_arg AND id=id_arg FOR UPDATE;
 ELSE
  SELECT version,revoked_at INTO current_version,revoked FROM public.resource_grants WHERE tenant_id=tenant_arg AND actor_id=actor_arg AND id=id_arg FOR UPDATE;
 END IF;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF revoked IS NOT NULL THEN RETURN jsonb_build_object('id',id_arg,'status','REVOKED','version',current_version,'replayed',true,'reauthenticationRequired',false);END IF;
 IF current_version<>version_arg THEN RAISE EXCEPTION 'PERMISSION_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 IF NOT public.oa_permission_session(session_arg) THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 IF kind_arg='ROLE' THEN
  UPDATE public.role_bindings SET revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=tenant_arg AND id=id_arg RETURNING version INTO next_version;
  event_kind='ROLE_WITHDRAWN';
 ELSE
  UPDATE public.resource_grants SET revoked_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=tenant_arg AND id=id_arg RETURNING version INTO next_version;
  UPDATE public.users SET auth_epoch=auth_epoch+1,version=version+1 WHERE tenant_id=tenant_arg AND id=actor_arg;
  event_kind='RESOURCE_WITHDRAWN';
 END IF;
 SELECT hash INTO prior_hash FROM public.permission_events WHERE tenant_id=tenant_arg AND owner_id=actor_arg ORDER BY seq DESC LIMIT 1;
 digest=encode(sha256(convert_to(jsonb_build_object('tenant',tenant_arg,'owner',actor_arg,'id',event_id,'kind',event_kind,'subject',id_arg,'version',next_version,'previous',prior_hash)::text,'UTF8')),'hex');
 INSERT INTO public.permission_events(tenant_id,owner_id,id,kind,subject_id,subject_version,previous_hash,hash) VALUES(tenant_arg,actor_arg,event_id,event_kind,id_arg,next_version,prior_hash,digest);
 DELETE FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=actor_arg;
 RETURN jsonb_build_object('id',id_arg,'status','REVOKED','version',next_version,'replayed',false,'reauthenticationRequired',true);
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_withdraw(text,uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_permission_withdraw(text,uuid,bigint,uuid) TO oa_app,oa_runtime;
