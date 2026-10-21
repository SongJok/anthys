-- Local resource policy management only. This never grants vendor consent,
-- source scopes, model egress, action approval or access to private bodies.
ALTER TABLE public.resource_grants
 ADD COLUMN managed_capability_version text,
 ADD COLUMN managed_binding_hash text,
 ADD COLUMN managed_manifest_id uuid,
 ADD CONSTRAINT managed_grant_binding CHECK (
  managed_capability_version IS NULL AND managed_binding_hash IS NULL AND managed_manifest_id IS NULL OR
  managed_capability_version IS NOT NULL AND managed_binding_hash IS NOT NULL AND managed_manifest_id IS NOT NULL
  AND managed_capability_version~'^[0-9]+\.[0-9]+\.[0-9]+$' AND managed_binding_hash~'^[a-f0-9]{64}$'
 ),
 ADD FOREIGN KEY(tenant_id,managed_manifest_id) REFERENCES public.permission_manifests(tenant_id,id);

CREATE FUNCTION public.oa_resource_grant_usable(grant_arg uuid,version_arg text,binding_arg text,input_arg text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.resource_grants g WHERE g.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND g.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND g.id=grant_arg AND (
  g.managed_capability_version IS NULL OR g.managed_capability_version=version_arg AND g.managed_binding_hash=binding_arg
  AND EXISTS(SELECT 1 FROM public.capability_bindings b JOIN public.permission_manifest_heads h ON h.tenant_id=b.tenant_id AND h.capability_id=b.logical_id AND h.capability_version=b.semantic_version
   JOIN public.permission_manifests m ON m.tenant_id=h.tenant_id AND m.id=h.manifest_id
   WHERE b.tenant_id=g.tenant_id AND b.logical_id=g.capability_id AND b.semantic_version=version_arg AND b.schema_hash=binding_arg AND b.state='READY' AND b.risk<>'FORBIDDEN'
   AND h.manifest_id=g.managed_manifest_id AND m.binding_hash=binding_arg AND m.descriptor->>'inputSchemaHash'=input_arg)
 ));
$$;
REVOKE ALL ON FUNCTION public.oa_resource_grant_usable(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_resource_grant_usable(uuid,text,text,text) TO oa_app,oa_runtime;

ALTER TABLE public.permission_events DROP CONSTRAINT permission_events_kind_check;
ALTER TABLE public.permission_events ADD CONSTRAINT permission_events_kind_check CHECK(kind IN('ROLE_WITHDRAWN','RESOURCE_WITHDRAWN','RESOURCE_GRANTED','RESOURCE_RENEWED','RESOURCE_REGRANTED'));
CREATE TABLE public.permission_admin_requests (
 tenant_id uuid NOT NULL,admin_id uuid NOT NULL,request_id uuid NOT NULL,target_id uuid NOT NULL,grant_id uuid NOT NULL,event_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN('CREATE','RENEW','REVOKE','REGRANT')),args_hash text NOT NULL CHECK(args_hash~'^[a-f0-9]{64}$'),
 review_hash text NOT NULL CHECK(review_hash~'^[a-f0-9]{64}$'),authority_id uuid NOT NULL,authority_version bigint NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,admin_id,request_id),FOREIGN KEY(tenant_id,admin_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,target_id) REFERENCES public.users(tenant_id,id),FOREIGN KEY(tenant_id,grant_id) REFERENCES public.resource_grants(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES public.permission_events(tenant_id,id),FOREIGN KEY(tenant_id,authority_id) REFERENCES public.role_bindings(tenant_id,id)
);
ALTER TABLE public.permission_admin_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_admin_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON public.permission_admin_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND admin_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE TRIGGER immutable_admin_request BEFORE UPDATE OR DELETE ON public.permission_admin_requests FOR EACH ROW EXECUTE FUNCTION public.oa_permission_immutable();
-- No direct application/runtime writes or reads on administration receipts.

CREATE FUNCTION public.oa_permission_admin_authority(session_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 authority public.role_bindings%ROWTYPE;
BEGIN
 PERFORM s.id FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=u.tenant_id
 WHERE s.tenant_id=tenant_arg AND s.owner_id=actor_arg AND s.id=session_arg FOR SHARE OF s,u,t;
 IF NOT public.oa_permission_session(session_arg) THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 SELECT b.* INTO authority FROM public.role_bindings b JOIN public.roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id
 WHERE b.tenant_id=tenant_arg AND b.subject_id=actor_arg AND r.name='TENANT_ADMIN' AND b.scope_kind='TENANT' AND b.scope_id=tenant_arg::text
 AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()) FOR SHARE OF b,r;
 IF NOT FOUND THEN RAISE EXCEPTION 'PERMISSION_ADMIN_DENIED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('id',authority.id,'version',authority.version);
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_admin_authority(uuid) FROM PUBLIC;

CREATE FUNCTION public.oa_permission_admin_mutate(operation_arg text,target_arg uuid,grant_arg uuid,expected_arg bigint,args_arg jsonb,request_arg uuid,session_arg uuid,runtime_arg jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 lock_arg uuid;authority jsonb;g public.resource_grants%ROWTYPE;b public.capability_bindings%ROWTYPE;m public.permission_manifests%ROWTYPE;
 prior public.permission_admin_requests%ROWTYPE;digest text;prior_hash text;event_arg uuid=gen_random_uuid();event_kind text;result_arg jsonb;
 expires_arg timestamptz;review_arg text;keys_arg text[];reauth_arg boolean=false;epoch_arg bigint;
BEGIN
 IF operation_arg IS NULL OR operation_arg NOT IN('CREATE','RENEW','REVOKE','REGRANT') OR tenant_arg IS NULL OR actor_arg IS NULL OR target_arg IS NULL OR request_arg IS NULL OR args_arg IS NULL OR jsonb_typeof(args_arg)<>'object' THEN
  RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 -- Serialize both administrator and target in stable order, before session,
 -- role and identity locks. Self withdrawal takes the same owner lock first.
 FOR lock_arg IN SELECT DISTINCT x FROM unnest(ARRAY[actor_arg,target_arg]) x ORDER BY x LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':'||lock_arg::text||':permissions',0));
 END LOOP;
 authority=public.oa_permission_admin_authority(session_arg);
 PERFORM id FROM public.users WHERE tenant_id=tenant_arg AND id=target_arg AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PERMISSION_NOT_FOUND' USING ERRCODE='P0002';END IF;
 SELECT auth_epoch INTO epoch_arg FROM public.users WHERE tenant_id=tenant_arg AND id=actor_arg;
 SELECT array_agg(k ORDER BY k) INTO keys_arg FROM jsonb_object_keys(args_arg) k;
 IF operation_arg IN('CREATE','REGRANT') THEN
  IF keys_arg IS DISTINCT FROM ARRAY['bindingHash','capabilityId','capabilityVersion','classificationCeiling','expiresAt','inputSchemaHash','resourceId','reviewReference']::text[] THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 ELSIF operation_arg='RENEW' THEN
  IF keys_arg IS DISTINCT FROM ARRAY['expiresAt','reviewReference']::text[] THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 ELSE
  IF keys_arg IS DISTINCT FROM ARRAY['reviewReference']::text[] THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(args_arg) e WHERE jsonb_typeof(e.value)<>'string') THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 review_arg=args_arg->>'reviewReference';
 IF review_arg!~'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 digest=encode(sha256(convert_to(jsonb_build_object('operation',operation_arg,'target',target_arg,'grant',grant_arg,'version',expected_arg,'args',args_arg)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.permission_admin_requests WHERE tenant_id=tenant_arg AND admin_id=actor_arg AND request_id=request_arg;
 IF FOUND THEN
  IF prior.args_hash<>digest THEN RAISE EXCEPTION 'PERMISSION_REQUEST_CONFLICT' USING ERRCODE='40001';END IF;
  SELECT * INTO g FROM public.resource_grants WHERE tenant_id=tenant_arg AND actor_id=target_arg AND id=prior.grant_id;
  RETURN prior.result||jsonb_build_object('replayed',true,'currentVersion',g.version,'currentState',CASE WHEN g.revoked_at IS NOT NULL THEN 'REVOKED' WHEN g.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'ACTIVE' END,'reauthenticationRequired',false);
 END IF;
 IF operation_arg='CREATE' THEN
  IF grant_arg IS NOT NULL OR expected_arg IS NOT NULL THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 ELSE
  IF grant_arg IS NULL OR expected_arg IS NULL OR expected_arg<1 THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
  SELECT * INTO g FROM public.resource_grants WHERE tenant_id=tenant_arg AND actor_id=target_arg AND id=grant_arg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERMISSION_NOT_FOUND' USING ERRCODE='P0002';END IF;
  IF g.audience_kind<>'PRIVATE_USER' OR g.audience_id<>target_arg::text THEN RAISE EXCEPTION 'PERMISSION_ADMIN_AUDIENCE_UNCERTIFIED' USING ERRCODE='42501';END IF;
  IF g.version<>expected_arg THEN RAISE EXCEPTION 'PERMISSION_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 END IF;
 IF operation_arg<>'REVOKE' THEN
  BEGIN expires_arg=(args_arg->>'expiresAt')::timestamptz;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END;
  IF expires_arg IS NULL OR NOT isfinite(expires_arg) OR expires_arg<=clock_timestamp() THEN RAISE EXCEPTION 'PERMISSION_GRANT_EXPIRY_INVALID' USING ERRCODE='22023';END IF;
  IF operation_arg IN('CREATE','REGRANT') THEN
   IF coalesce(args_arg->>'capabilityId','')!~'^[a-z][a-z0-9_.-]{0,127}$' OR length(args_arg->>'capabilityVersion')>64 OR coalesce(args_arg->>'capabilityVersion','')!~'^[0-9]+\.[0-9]+\.[0-9]+$'
    OR coalesce(args_arg->>'bindingHash','')!~'^[a-f0-9]{64}$' OR coalesce(args_arg->>'inputSchemaHash','')!~'^[a-f0-9]{64}$'
    OR coalesce(args_arg->>'resourceId','')!~'^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,511}$' OR strpos(args_arg->>'resourceId','://')>0
    OR coalesce(args_arg->>'classificationCeiling','') NOT IN('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED') THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
   SELECT * INTO b FROM public.capability_bindings WHERE tenant_id=tenant_arg AND logical_id=args_arg->>'capabilityId' AND semantic_version=args_arg->>'capabilityVersion' AND schema_hash=args_arg->>'bindingHash' AND state='READY' AND risk<>'FORBIDDEN' FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'PERMISSION_CAPABILITY_UNAVAILABLE' USING ERRCODE='42501';END IF;
   SELECT x.* INTO m FROM public.permission_manifest_heads h JOIN public.permission_manifests x ON x.tenant_id=h.tenant_id AND x.id=h.manifest_id WHERE h.tenant_id=tenant_arg AND h.capability_id=b.logical_id AND h.capability_version=b.semantic_version FOR SHARE OF h,x;
   IF m.id IS NULL OR m.binding_hash<>b.schema_hash OR m.descriptor->>'inputSchemaHash' IS DISTINCT FROM args_arg->>'inputSchemaHash' OR m.descriptor->>'risk' IS DISTINCT FROM b.risk
    OR runtime_arg IS NULL OR runtime_arg->>'id' IS DISTINCT FROM b.logical_id OR runtime_arg->>'version' IS DISTINCT FROM b.semantic_version OR runtime_arg->>'state' IS DISTINCT FROM 'READY'
    OR runtime_arg->>'bindingHash' IS DISTINCT FROM b.schema_hash OR runtime_arg->>'inputSchemaHash' IS DISTINCT FROM args_arg->>'inputSchemaHash' OR runtime_arg->>'risk' IS DISTINCT FROM b.risk
    OR runtime_arg->>'provider' IS DISTINCT FROM m.descriptor->>'provider' THEN RAISE EXCEPTION 'PERMISSION_MANIFEST_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;
   IF operation_arg='REGRANT' AND (g.capability_id<>b.logical_id OR g.resource_id<>args_arg->>'resourceId') THEN RAISE EXCEPTION 'PERMISSION_GRANT_TARGET_IMMUTABLE' USING ERRCODE='22023';END IF;
  ELSE
   IF g.revoked_at IS NOT NULL OR g.managed_manifest_id IS NULL THEN RAISE EXCEPTION 'PERMISSION_GRANT_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;
   IF expires_arg<=g.expires_at THEN RAISE EXCEPTION 'PERMISSION_GRANT_EXPIRY_INVALID' USING ERRCODE='22023';END IF;
   SELECT * INTO b FROM public.capability_bindings WHERE tenant_id=tenant_arg AND logical_id=g.capability_id AND semantic_version=g.managed_capability_version AND schema_hash=g.managed_binding_hash AND state='READY' AND risk<>'FORBIDDEN' FOR SHARE;
   SELECT x.* INTO m FROM public.permission_manifest_heads h JOIN public.permission_manifests x ON x.tenant_id=h.tenant_id AND x.id=h.manifest_id WHERE h.tenant_id=tenant_arg AND h.capability_id=g.capability_id AND h.capability_version=g.managed_capability_version FOR SHARE OF h,x;
   IF b.id IS NULL OR m.id IS DISTINCT FROM g.managed_manifest_id OR m.binding_hash IS DISTINCT FROM b.schema_hash OR runtime_arg IS NULL
    OR runtime_arg->>'id' IS DISTINCT FROM b.logical_id OR runtime_arg->>'version' IS DISTINCT FROM b.semantic_version OR runtime_arg->>'state' IS DISTINCT FROM 'READY'
    OR runtime_arg->>'bindingHash' IS DISTINCT FROM b.schema_hash OR runtime_arg->>'inputSchemaHash' IS DISTINCT FROM m.descriptor->>'inputSchemaHash' OR runtime_arg->>'risk' IS DISTINCT FROM b.risk OR runtime_arg->>'provider' IS DISTINCT FROM m.descriptor->>'provider'
   THEN RAISE EXCEPTION 'PERMISSION_MANIFEST_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;
  END IF;
 END IF;
 -- Recheck timed admission after any lock wait, before changing policy.
 PERFORM public.oa_permission_admin_authority(session_arg);
 IF operation_arg='CREATE' THEN
  IF EXISTS(SELECT 1 FROM public.resource_grants WHERE tenant_id=tenant_arg AND actor_id=target_arg AND capability_id=b.logical_id AND resource_id=args_arg->>'resourceId' AND audience_kind='PRIVATE_USER' AND audience_id=target_arg::text) THEN RAISE EXCEPTION 'PERMISSION_GRANT_EXISTS' USING ERRCODE='23505';END IF;
  INSERT INTO public.resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at,managed_capability_version,managed_binding_hash,managed_manifest_id)
  VALUES(tenant_arg,gen_random_uuid(),target_arg,b.logical_id,args_arg->>'resourceId','PRIVATE_USER',target_arg::text,args_arg->>'classificationCeiling',expires_arg,b.semantic_version,b.schema_hash,m.id) RETURNING * INTO g;
  event_kind='RESOURCE_GRANTED';
 ELSIF operation_arg='RENEW' THEN
  UPDATE public.resource_grants SET expires_at=expires_arg,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=tenant_arg AND id=g.id RETURNING * INTO g;
  event_kind='RESOURCE_RENEWED';
 ELSIF operation_arg='REGRANT' THEN
  UPDATE public.resource_grants SET classification_ceiling=args_arg->>'classificationCeiling',expires_at=expires_arg,revoked_at=NULL,managed_capability_version=b.semantic_version,managed_binding_hash=b.schema_hash,managed_manifest_id=m.id,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=tenant_arg AND id=g.id RETURNING * INTO g;
  event_kind='RESOURCE_REGRANTED';
 ELSE
  IF g.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'PERMISSION_GRANT_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;
  UPDATE public.resource_grants SET revoked_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE tenant_id=tenant_arg AND id=g.id RETURNING * INTO g;
  event_kind='RESOURCE_WITHDRAWN';
 END IF;
 IF operation_arg IN('REVOKE','REGRANT') THEN
  UPDATE public.users SET auth_epoch=auth_epoch+1,version=version+1 WHERE tenant_id=tenant_arg AND id=target_arg;
  reauth_arg=target_arg=actor_arg;
 END IF;
 DELETE FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=target_arg;
 SELECT hash INTO prior_hash FROM public.permission_events WHERE tenant_id=tenant_arg AND owner_id=target_arg ORDER BY seq DESC LIMIT 1;
 INSERT INTO public.permission_events(tenant_id,owner_id,id,kind,subject_id,subject_version,previous_hash,hash)
 VALUES(tenant_arg,target_arg,event_arg,event_kind,g.id,g.version,prior_hash,encode(sha256(convert_to(jsonb_build_object('tenant',tenant_arg,'owner',target_arg,'id',event_arg,'kind',event_kind,'subject',g.id,'version',g.version,'previous',prior_hash)::text,'UTF8')),'hex'));
 result_arg=jsonb_build_object('id',g.id,'targetUserId',target_arg,'version',g.version,'state',CASE WHEN g.revoked_at IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END,'replayed',false,'reauthenticationRequired',reauth_arg,'platformPermissionsVerified',false,'requestId',request_arg,'currentVersion',g.version,'currentState',CASE WHEN g.revoked_at IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END);
 INSERT INTO public.permission_admin_requests(tenant_id,admin_id,request_id,target_id,grant_id,event_id,operation,args_hash,review_hash,authority_id,authority_version,result)
 VALUES(tenant_arg,actor_arg,request_arg,target_arg,g.id,event_arg,operation_arg,digest,encode(sha256(convert_to(review_arg,'UTF8')),'hex'),(authority->>'id')::uuid,(authority->>'version')::bigint,result_arg);
 -- Self revocation invalidates the session by design. Verify that this is
 -- exactly our own epoch change, not a revoked/expired session or role.
 IF NOT EXISTS(SELECT 1 FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=u.tenant_id JOIN public.role_bindings rb ON rb.tenant_id=u.tenant_id AND rb.id=(authority->>'id')::uuid
 WHERE s.tenant_id=tenant_arg AND s.owner_id=actor_arg AND s.id=session_arg AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='ACTIVE' AND t.status='ACTIVE'
 AND u.auth_epoch=s.auth_epoch+CASE WHEN reauth_arg THEN 1 ELSE 0 END AND s.auth_epoch=epoch_arg AND rb.revoked_at IS NULL AND (rb.expires_at IS NULL OR rb.expires_at>clock_timestamp()) AND rb.version=(authority->>'version')::bigint)
 THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 RETURN result_arg;
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_admin_mutate(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_permission_admin_mutate(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb) TO oa_app;

CREATE FUNCTION public.oa_permission_admin_resources(session_arg uuid,target_arg uuid,cursor_arg uuid,id_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;items_arg jsonb;next_arg uuid;
BEGIN
 PERFORM public.oa_permission_admin_authority(session_arg);
 WITH page AS (
  SELECT g.* FROM public.resource_grants g WHERE g.tenant_id=tenant_arg AND (target_arg IS NULL OR g.actor_id=target_arg) AND (cursor_arg IS NULL OR g.id>cursor_arg) AND (id_arg IS NULL OR g.id=id_arg) ORDER BY g.id LIMIT 51
 ), visible AS (SELECT * FROM page ORDER BY id LIMIT 50)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'targetUserId',actor_id,'capabilityId',left(capability_id,256),'capabilityVersion',managed_capability_version,'bindingHash',managed_binding_hash,'manifestId',managed_manifest_id,
  'resourceId',left(resource_id,512),'resourceTruncated',length(resource_id)>512,'classificationCeiling',left(classification_ceiling,64),'expiresAt',expires_at,'version',version,'managed',managed_manifest_id IS NOT NULL,
  'state',CASE WHEN revoked_at IS NOT NULL THEN 'REVOKED' WHEN expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'ACTIVE' END) ORDER BY id),'[]'::jsonb),
  CASE WHEN (SELECT count(*) FROM page)>50 THEN (SELECT id FROM visible ORDER BY id DESC LIMIT 1) ELSE NULL END INTO items_arg,next_arg FROM visible;
 PERFORM public.oa_permission_admin_authority(session_arg);
 RETURN jsonb_build_object('items',items_arg,'nextCursor',next_arg,'scope','TENANT_POLICY_METADATA_ONLY','platformPermissionsVerified',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_admin_resources(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_permission_admin_resources(uuid,uuid,uuid,uuid) TO oa_app;

-- Diagnostics must describe the same managed-version boundary as dispatch.
CREATE OR REPLACE FUNCTION public.oa_permission_diagnose(grant_arg uuid,version_arg text,session_arg uuid,runtime_arg jsonb,force_arg boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 g public.resource_grants%ROWTYPE;b public.capability_bindings%ROWTYPE;m public.permission_manifests%ROWTYPE;u public.users%ROWTYPE;t public.tenants%ROWTYPE;d public.dws_identities%ROWTYPE;
 grant_state text;manifest_state text;identity_state text;runtime_state text;reason text;local_state text;identity_ref uuid;
 snapshot jsonb;cache_key_arg text;prior public.permission_diagnostics%ROWTYPE;result_arg jsonb;checked timestamptz;
BEGIN
 IF NOT public.oa_permission_session(session_arg) THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 IF version_arg IS NULL OR length(version_arg)>64 OR version_arg!~'^[0-9]+\.[0-9]+\.[0-9]+$' OR runtime_arg IS NULL OR jsonb_typeof(runtime_arg)<>'object' OR force_arg IS NULL THEN RAISE EXCEPTION 'PERMISSION_DIAGNOSTIC_INPUT_INVALID' USING ERRCODE='22023';END IF;
 -- Same owner lock as withdrawal, acquired before grant/user locks. A cache
 -- miss or forced refresh cannot race another request past the storage bound.
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':'||actor_arg::text||':permissions',0));
 IF NOT public.oa_permission_session(session_arg) THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 -- The same durable owner window is shared by sessions and API processes.
 INSERT INTO public.permission_diagnostic_limits(tenant_id,owner_id,window_started,requests)
 VALUES(tenant_arg,actor_arg,clock_timestamp(),1)
 ON CONFLICT(tenant_id,owner_id) DO UPDATE SET
  requests=CASE WHEN permission_diagnostic_limits.window_started<=clock_timestamp()-interval '1 minute' THEN 1 ELSE permission_diagnostic_limits.requests+1 END,
  window_started=CASE WHEN permission_diagnostic_limits.window_started<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE permission_diagnostic_limits.window_started END
 WHERE permission_diagnostic_limits.window_started<=clock_timestamp()-interval '1 minute' OR permission_diagnostic_limits.requests<120;
 IF NOT FOUND THEN RAISE EXCEPTION 'PERMISSION_DIAGNOSTIC_RATE_LIMITED' USING ERRCODE='54000';END IF;
 DELETE FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND expires_at<=clock_timestamp();
 -- Keep at most127 previous entries; the subsequent upsert adds at most one.
 -- Diagnostics carry no execution authority, so eviction only recomputes metadata.
 DELETE FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=actor_arg AND id IN (
  SELECT id FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=actor_arg ORDER BY checked_at DESC,id DESC OFFSET 127
 );
 SELECT * INTO t FROM public.tenants WHERE tenant_id=tenant_arg FOR SHARE;
 SELECT * INTO g FROM public.resource_grants WHERE tenant_id=tenant_arg AND actor_id=actor_arg AND id=grant_arg FOR SHARE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO u FROM public.users WHERE tenant_id=tenant_arg AND id=actor_arg FOR SHARE;
 SELECT * INTO b FROM public.capability_bindings WHERE tenant_id=tenant_arg AND logical_id=g.capability_id AND semantic_version=version_arg FOR SHARE;
 SELECT x.* INTO m FROM public.permission_manifest_heads h JOIN public.permission_manifests x ON x.tenant_id=h.tenant_id AND x.id=h.manifest_id WHERE h.tenant_id=tenant_arg AND h.capability_id=g.capability_id AND h.capability_version=version_arg FOR SHARE OF h;
 IF m.descriptor->>'provider'='DWS' THEN SELECT * INTO d FROM public.dws_identities WHERE tenant_id=tenant_arg AND owner_id=actor_arg FOR SHARE;END IF;
 grant_state=CASE WHEN g.revoked_at IS NOT NULL THEN 'REVOKED' WHEN g.expires_at<=clock_timestamp() THEN 'EXPIRED' WHEN NOT public.oa_resource_grant_usable(g.id,version_arg,runtime_arg->>'bindingHash',runtime_arg->>'inputSchemaHash') THEN 'VERSION_UNCERTIFIED' WHEN g.classification_ceiling NOT IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED') THEN 'CLASSIFICATION_UNCERTIFIED' WHEN g.audience_kind<>'PRIVATE_USER' OR g.audience_id<>actor_arg::text THEN 'AUDIENCE_UNCERTIFIED' ELSE 'ACTIVE' END;
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
