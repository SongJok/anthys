-- Local tenant role/delegation administration only. This never creates a
-- platform authorization, group ownership proof, model egress consent or a
-- write approval. GROUP bindings remain governed by the group-contract flow.
ALTER TABLE public.role_bindings
 ADD COLUMN managed_review_hash text CHECK(managed_review_hash IS NULL OR managed_review_hash~'^[a-f0-9]{64}$'),
 ADD COLUMN managed_by uuid,
 ADD CONSTRAINT managed_role_binding CHECK(
  managed_review_hash IS NULL AND managed_by IS NULL OR
  managed_review_hash IS NOT NULL AND managed_by IS NOT NULL
 ),
 ADD FOREIGN KEY(tenant_id,managed_by) REFERENCES public.users(tenant_id,id);

-- Historical revoked bindings must remain immutable evidence. Only one live
-- binding for the same role, subject and exact scope may exist at a time.
DO $$ DECLARE item record;
BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='public.role_bindings'::regclass AND contype='u'
  AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, role_id, subject_id, scope_kind, scope_id)'
 LOOP EXECUTE format('ALTER TABLE public.role_bindings DROP CONSTRAINT %I',item.conname);END LOOP;
END $$;
CREATE UNIQUE INDEX role_bindings_live_scope ON public.role_bindings(tenant_id,role_id,subject_id,scope_kind,scope_id) WHERE revoked_at IS NULL;

ALTER TABLE public.permission_events DROP CONSTRAINT permission_events_kind_check;
ALTER TABLE public.permission_events ADD CONSTRAINT permission_events_kind_check CHECK(kind IN('ROLE_WITHDRAWN','ROLE_ASSIGNED','ROLE_RENEWED','RESOURCE_WITHDRAWN','RESOURCE_GRANTED','RESOURCE_RENEWED','RESOURCE_REGRANTED'));

CREATE TABLE public.role_admin_requests (
 tenant_id uuid NOT NULL,admin_id uuid NOT NULL,request_id uuid NOT NULL,target_id uuid NOT NULL,binding_id uuid NOT NULL,event_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN('ASSIGN','RENEW','REVOKE')),args_hash text NOT NULL CHECK(args_hash~'^[a-f0-9]{64}$'),
 review_hash text NOT NULL CHECK(review_hash~'^[a-f0-9]{64}$'),authority_id uuid NOT NULL,authority_version bigint NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,admin_id,request_id),FOREIGN KEY(tenant_id,admin_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,target_id) REFERENCES public.users(tenant_id,id),FOREIGN KEY(tenant_id,binding_id) REFERENCES public.role_bindings(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES public.permission_events(tenant_id,id),FOREIGN KEY(tenant_id,authority_id) REFERENCES public.role_bindings(tenant_id,id)
);
ALTER TABLE public.role_admin_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_admin_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON public.role_admin_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND admin_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE TRIGGER immutable_admin_request BEFORE UPDATE OR DELETE ON public.role_admin_requests FOR EACH ROW EXECUTE FUNCTION public.oa_permission_immutable();

CREATE FUNCTION public.oa_permission_admin_role_bindings(session_arg uuid,target_arg uuid,cursor_arg uuid,id_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;items_arg jsonb;next_arg uuid;
BEGIN
 PERFORM public.oa_permission_admin_authority(session_arg);
 WITH page AS (
  SELECT b.id,b.subject_id,r.name role_name,b.scope_kind,b.scope_id,b.expires_at,b.version,b.revoked_at,b.managed_review_hash
  FROM public.role_bindings b JOIN public.roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id
  WHERE b.tenant_id=tenant_arg AND (target_arg IS NULL OR b.subject_id=target_arg) AND (cursor_arg IS NULL OR b.id>cursor_arg) AND (id_arg IS NULL OR b.id=id_arg)
  ORDER BY b.id LIMIT 51
 ), visible AS (SELECT * FROM page ORDER BY id LIMIT 50)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'targetUserId',subject_id,'roleName',left(role_name,128),'scopeKind',scope_kind,'scopeId',left(scope_id,512),
  'scopeTruncated',length(scope_id)>512,'expiresAt',expires_at,'version',version,'managed',managed_review_hash IS NOT NULL,
  'state',CASE WHEN revoked_at IS NOT NULL THEN 'REVOKED' WHEN expires_at IS NOT NULL AND expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'ACTIVE' END) ORDER BY id),'[]'::jsonb),
  CASE WHEN (SELECT count(*) FROM page)>50 THEN (SELECT id FROM visible ORDER BY id DESC LIMIT 1) ELSE NULL END INTO items_arg,next_arg FROM visible;
 PERFORM public.oa_permission_admin_authority(session_arg);
 RETURN jsonb_build_object('items',items_arg,'nextCursor',next_arg,'scope','TENANT_ROLE_METADATA_ONLY','platformPermissionsVerified',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_admin_role_bindings(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_permission_admin_role_bindings(uuid,uuid,uuid,uuid) TO oa_app;

CREATE FUNCTION public.oa_permission_admin_role_mutate(operation_arg text,target_arg uuid,binding_arg uuid,expected_arg bigint,args_arg jsonb,request_arg uuid,session_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 lock_arg uuid;authority jsonb;b public.role_bindings%ROWTYPE;r public.roles%ROWTYPE;prior public.role_admin_requests%ROWTYPE;
 digest text;prior_hash text;event_arg uuid=gen_random_uuid();event_kind text;result_arg jsonb;
 expires_arg timestamptz;review_arg text;keys_arg text[];reauth_arg boolean=false;epoch_arg bigint;scope_arg text;
BEGIN
 IF operation_arg IS NULL OR operation_arg NOT IN('ASSIGN','RENEW','REVOKE') OR tenant_arg IS NULL OR actor_arg IS NULL OR target_arg IS NULL
  OR request_arg IS NULL OR args_arg IS NULL OR jsonb_typeof(args_arg)<>'object'
  OR operation_arg='ASSIGN' AND binding_arg IS NOT NULL OR operation_arg<>'ASSIGN' AND binding_arg IS NULL
 THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 FOR lock_arg IN SELECT DISTINCT x FROM unnest(ARRAY[actor_arg,target_arg]) x ORDER BY x LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':'||lock_arg::text||':permissions',0));
 END LOOP;
 authority=public.oa_permission_admin_authority(session_arg);
 PERFORM id FROM public.users WHERE tenant_id=tenant_arg AND id=target_arg AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PERMISSION_NOT_FOUND' USING ERRCODE='P0002';END IF;
 SELECT auth_epoch INTO epoch_arg FROM public.users WHERE tenant_id=tenant_arg AND id=actor_arg;
 SELECT array_agg(k ORDER BY k) INTO keys_arg FROM jsonb_object_keys(args_arg) k;
 IF operation_arg='ASSIGN' THEN
  IF keys_arg IS DISTINCT FROM ARRAY['expiresAt','reviewReference','roleName','scopeId','scopeKind']::text[] THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 ELSIF operation_arg='RENEW' THEN
  IF keys_arg IS DISTINCT FROM ARRAY['expiresAt','reviewReference']::text[] THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 ELSE
  IF keys_arg IS DISTINCT FROM ARRAY['reviewReference']::text[] THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(args_arg) e WHERE jsonb_typeof(e.value)<>'string') THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 review_arg=args_arg->>'reviewReference';
 IF review_arg!~'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 digest=encode(sha256(convert_to(jsonb_build_object('operation',operation_arg,'target',target_arg,'binding',binding_arg,'version',expected_arg,'args',args_arg)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.role_admin_requests WHERE tenant_id=tenant_arg AND admin_id=actor_arg AND request_id=request_arg;
 IF FOUND THEN
  IF prior.args_hash<>digest THEN RAISE EXCEPTION 'PERMISSION_REQUEST_CONFLICT' USING ERRCODE='40001';END IF;
  SELECT * INTO b FROM public.role_bindings WHERE tenant_id=tenant_arg AND subject_id=target_arg AND id=prior.binding_id;
  RETURN prior.result||jsonb_build_object('replayed',true,'currentVersion',b.version,'currentState',CASE WHEN b.revoked_at IS NOT NULL THEN 'REVOKED' WHEN b.expires_at IS NOT NULL AND b.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'ACTIVE' END,'reauthenticationRequired',false);
 END IF;
 IF operation_arg='ASSIGN' THEN
  IF expected_arg IS NOT NULL THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
 ELSE
  IF expected_arg IS NULL OR expected_arg<1 THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END IF;
  SELECT * INTO b FROM public.role_bindings WHERE tenant_id=tenant_arg AND subject_id=target_arg AND id=binding_arg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERMISSION_NOT_FOUND' USING ERRCODE='P0002';END IF;
  IF b.version<>expected_arg THEN RAISE EXCEPTION 'PERMISSION_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
  SELECT * INTO r FROM public.roles WHERE tenant_id=tenant_arg AND id=b.role_id FOR SHARE;
  IF r.name IS NULL OR r.name NOT IN('TENANT_ADMIN','ACTION_APPROVER','SECURITY_OPERATOR') THEN RAISE EXCEPTION 'PERMISSION_ROLE_NOT_ASSIGNABLE' USING ERRCODE='42501';END IF;
 END IF;
 IF operation_arg<>'REVOKE' THEN
  BEGIN expires_arg=(args_arg->>'expiresAt')::timestamptz;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'PERMISSION_ADMIN_INPUT_INVALID' USING ERRCODE='22023';END;
  IF expires_arg IS NULL OR NOT isfinite(expires_arg) OR expires_arg<=clock_timestamp() OR expires_arg>clock_timestamp()+interval '366 days' THEN RAISE EXCEPTION 'PERMISSION_ROLE_EXPIRY_INVALID' USING ERRCODE='22023';END IF;
 END IF;
 IF operation_arg='ASSIGN' THEN
  scope_arg=args_arg->>'scopeId';
  SELECT * INTO r FROM public.roles WHERE tenant_id=tenant_arg AND name=args_arg->>'roleName' FOR SHARE;
  IF NOT FOUND OR r.name NOT IN('TENANT_ADMIN','ACTION_APPROVER','SECURITY_OPERATOR') THEN RAISE EXCEPTION 'PERMISSION_ROLE_NOT_ASSIGNABLE' USING ERRCODE='42501';END IF;
  IF args_arg->>'scopeKind' NOT IN('TENANT','CAPABILITY','CONNECTOR','RESOURCE','TASK','USER') OR scope_arg IS NULL OR length(scope_arg)<1 OR length(scope_arg)>512 THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
  IF r.name='TENANT_ADMIN' AND (args_arg->>'scopeKind'<>'TENANT' OR scope_arg<>tenant_arg::text) THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
  IF args_arg->>'scopeKind'='TENANT' THEN
   IF scope_arg<>tenant_arg::text THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
  ELSIF args_arg->>'scopeKind'='CAPABILITY' THEN
   IF NOT EXISTS(SELECT 1 FROM public.capability_bindings WHERE tenant_id=tenant_arg AND logical_id=scope_arg AND state='READY') THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
  ELSIF args_arg->>'scopeKind'='CONNECTOR' THEN
   IF scope_arg!~'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
  ELSIF args_arg->>'scopeKind'='RESOURCE' THEN
   IF length(scope_arg)>512 OR scope_arg!~'^[A-Za-z0-9][A-Za-z0-9_./:@-]*$' OR strpos(scope_arg,'://')>0 THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
  ELSIF args_arg->>'scopeKind'='TASK' THEN
   IF NOT pg_input_is_valid(scope_arg,'uuid') THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.tasks WHERE tenant_id=tenant_arg AND id=scope_arg::uuid) THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
  ELSE
   IF NOT pg_input_is_valid(scope_arg,'uuid') THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.users WHERE tenant_id=tenant_arg AND id=scope_arg::uuid AND status='ACTIVE') THEN RAISE EXCEPTION 'PERMISSION_ROLE_SCOPE_INVALID' USING ERRCODE='22023';END IF;
  END IF;
 END IF;
 PERFORM public.oa_permission_admin_authority(session_arg);
 IF operation_arg='ASSIGN' THEN
  IF EXISTS(SELECT 1 FROM public.role_bindings WHERE tenant_id=tenant_arg AND role_id=r.id AND subject_id=target_arg AND scope_kind=args_arg->>'scopeKind' AND scope_id=scope_arg AND revoked_at IS NULL)
  THEN RAISE EXCEPTION 'PERMISSION_ROLE_BINDING_EXISTS' USING ERRCODE='23505';END IF;
  INSERT INTO public.role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id,expires_at,managed_review_hash,managed_by)
  VALUES(tenant_arg,gen_random_uuid(),r.id,target_arg,args_arg->>'scopeKind',scope_arg,expires_arg,encode(sha256(convert_to(review_arg,'UTF8')),'hex'),actor_arg) RETURNING * INTO b;
  event_kind='ROLE_ASSIGNED';
 ELSIF operation_arg='RENEW' THEN
  IF b.revoked_at IS NOT NULL OR b.managed_review_hash IS NULL OR b.expires_at IS NULL OR b.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PERMISSION_ROLE_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;
  IF expires_arg<=b.expires_at THEN RAISE EXCEPTION 'PERMISSION_ROLE_EXPIRY_INVALID' USING ERRCODE='22023';END IF;
  UPDATE public.role_bindings SET expires_at=expires_arg,managed_review_hash=encode(sha256(convert_to(review_arg,'UTF8')),'hex'),managed_by=actor_arg,updated_at=clock_timestamp()
  WHERE tenant_id=tenant_arg AND id=b.id RETURNING * INTO b;
  event_kind='ROLE_RENEWED';
 ELSE
  IF b.revoked_at IS NOT NULL OR b.managed_review_hash IS NULL THEN RAISE EXCEPTION 'PERMISSION_ROLE_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;
  IF r.name='TENANT_ADMIN' AND b.scope_kind='TENANT' AND b.scope_id=tenant_arg::text AND NOT EXISTS(
   SELECT 1 FROM public.role_bindings other JOIN public.roles rr ON rr.tenant_id=other.tenant_id AND rr.id=other.role_id
   WHERE other.tenant_id=tenant_arg AND other.id<>b.id AND rr.name='TENANT_ADMIN' AND other.scope_kind='TENANT' AND other.scope_id=tenant_arg::text
   AND other.revoked_at IS NULL AND (other.expires_at IS NULL OR other.expires_at>clock_timestamp())
  ) THEN RAISE EXCEPTION 'PERMISSION_ROLE_LAST_ADMIN' USING ERRCODE='23514';END IF;
  UPDATE public.role_bindings SET revoked_at=clock_timestamp(),managed_review_hash=encode(sha256(convert_to(review_arg,'UTF8')),'hex'),managed_by=actor_arg,updated_at=clock_timestamp()
  WHERE tenant_id=tenant_arg AND id=b.id RETURNING * INTO b;
  event_kind='ROLE_WITHDRAWN';
 END IF;
 reauth_arg=target_arg=actor_arg;
 DELETE FROM public.permission_diagnostics WHERE tenant_id=tenant_arg AND owner_id=target_arg;
 SELECT hash INTO prior_hash FROM public.permission_events WHERE tenant_id=tenant_arg AND owner_id=target_arg ORDER BY seq DESC LIMIT 1;
 INSERT INTO public.permission_events(tenant_id,owner_id,id,kind,subject_id,subject_version,previous_hash,hash)
 VALUES(tenant_arg,target_arg,event_arg,event_kind,b.id,b.version,prior_hash,encode(sha256(convert_to(jsonb_build_object('tenant',tenant_arg,'owner',target_arg,'id',event_arg,'kind',event_kind,'subject',b.id,'version',b.version,'previous',prior_hash)::text,'UTF8')),'hex'));
 result_arg=jsonb_build_object('id',b.id,'targetUserId',target_arg,'roleName',r.name,'scopeKind',b.scope_kind,'scopeId',b.scope_id,'version',b.version,
  'state',CASE WHEN b.revoked_at IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END,'expiresAt',b.expires_at,'replayed',false,'reauthenticationRequired',reauth_arg,
  'platformPermissionsVerified',false,'requestId',request_arg,'currentVersion',b.version,'currentState',CASE WHEN b.revoked_at IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END);
 INSERT INTO public.role_admin_requests(tenant_id,admin_id,request_id,target_id,binding_id,event_id,operation,args_hash,review_hash,authority_id,authority_version,result)
 VALUES(tenant_arg,actor_arg,request_arg,target_arg,b.id,event_arg,operation_arg,digest,encode(sha256(convert_to(review_arg,'UTF8')),'hex'),(authority->>'id')::uuid,(authority->>'version')::bigint,result_arg);
 IF NOT EXISTS(SELECT 1 FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=u.tenant_id
  JOIN public.role_bindings rb ON rb.tenant_id=u.tenant_id AND rb.id=(authority->>'id')::uuid
  WHERE s.tenant_id=tenant_arg AND s.owner_id=actor_arg AND s.id=session_arg AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='ACTIVE' AND t.status='ACTIVE'
  AND u.auth_epoch=s.auth_epoch+CASE WHEN reauth_arg THEN 1 ELSE 0 END AND s.auth_epoch=epoch_arg
  AND (rb.revoked_at IS NULL AND (rb.expires_at IS NULL OR rb.expires_at>clock_timestamp()) AND rb.version=(authority->>'version')::bigint
   OR reauth_arg AND b.id=(authority->>'id')::uuid AND rb.version=b.version AND (b.revoked_at IS NOT NULL OR operation_arg='RENEW')))
 THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 RETURN result_arg;
END $$;
REVOKE ALL ON FUNCTION public.oa_permission_admin_role_mutate(text,uuid,uuid,bigint,jsonb,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_permission_admin_role_mutate(text,uuid,uuid,bigint,jsonb,uuid,uuid) TO oa_app;
