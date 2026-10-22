-- Certified data-template lifecycle for T093. Definitions remain in the
-- reviewed file registry; this table records which exact certified version was
-- approved and active. Publishing never accepts raw SQL, tenant scope or
-- credentials, and never claims upstream/live certification.
CREATE TABLE public.company_data_template_versions (
 tenant_id uuid NOT NULL,
 template_key text NOT NULL CHECK(template_key~'^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$' AND length(template_key)<=128),
 template_version text NOT NULL CHECK(template_version~'^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
 template_hash text NOT NULL CHECK(template_hash~'^[a-f0-9]{64}$'),
 certification_reference text NOT NULL CHECK(length(certification_reference) BETWEEN 8 AND 255),
 golden_hash text NOT NULL CHECK(golden_hash~'^[a-f0-9]{64}$'),
 published_by uuid NOT NULL,
 published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,template_key,template_version),
 FOREIGN KEY(tenant_id,published_by) REFERENCES public.users(tenant_id,id)
);
ALTER TABLE public.company_data_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_data_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON public.company_data_template_versions USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER immutable_template_version BEFORE UPDATE OR DELETE ON public.company_data_template_versions FOR EACH ROW EXECUTE FUNCTION public.oa_permission_immutable();
REVOKE ALL ON public.company_data_template_versions FROM PUBLIC;
GRANT SELECT ON public.company_data_template_versions TO oa_app,oa_runtime;

CREATE TABLE public.company_data_template_active (
 tenant_id uuid NOT NULL,
 template_key text NOT NULL,
 active_version text NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,template_key),
 FOREIGN KEY(tenant_id,template_key,active_version) REFERENCES public.company_data_template_versions(tenant_id,template_key,template_version),
 FOREIGN KEY(tenant_id,updated_by) REFERENCES public.users(tenant_id,id)
);
ALTER TABLE public.company_data_template_active ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_data_template_active FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON public.company_data_template_active USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.company_data_template_active FROM PUBLIC;
GRANT SELECT ON public.company_data_template_active TO oa_app,oa_runtime;

CREATE TABLE public.company_data_template_requests (
 tenant_id uuid NOT NULL,admin_id uuid NOT NULL,request_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN('PUBLISH','ROLLBACK')),
 template_key text NOT NULL,template_version text NOT NULL,
 args_hash text NOT NULL CHECK(args_hash~'^[a-f0-9]{64}$'),review_hash text NOT NULL CHECK(review_hash~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,admin_id,request_id),
 FOREIGN KEY(tenant_id,admin_id) REFERENCES public.users(tenant_id,id)
);
ALTER TABLE public.company_data_template_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_data_template_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON public.company_data_template_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND admin_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE TRIGGER immutable_template_request BEFORE UPDATE OR DELETE ON public.company_data_template_requests FOR EACH ROW EXECUTE FUNCTION public.oa_permission_immutable();
REVOKE ALL ON public.company_data_template_requests FROM PUBLIC;

-- Execution remains on the reviewed file registry, but once a lifecycle entry
-- exists for a key only its active version can satisfy a new or retained scope.
CREATE FUNCTION public.oa_company_data_template_is_active(key_arg text,version_arg text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.company_data_template_active a WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.template_key=key_arg)
  OR EXISTS(SELECT 1 FROM public.company_data_template_active a WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.template_key=key_arg AND a.active_version=version_arg)
$$;
REVOKE ALL ON FUNCTION public.oa_company_data_template_is_active(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_company_data_template_is_active(text,text) TO oa_app,oa_runtime;

CREATE FUNCTION public.oa_company_data_template_list(session_arg uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;items_arg jsonb;count_arg integer;
BEGIN
 PERFORM public.oa_permission_admin_authority(session_arg);
 SELECT count(*) INTO count_arg FROM public.company_data_template_versions WHERE tenant_id=tenant_arg;
 SELECT coalesce(jsonb_agg(jsonb_build_object('templateKey',v.template_key,'templateVersion',v.template_version,'templateHash',v.template_hash,
  'certificationReference',v.certification_reference,'publishedAt',v.published_at,'active',a.active_version=v.template_version,
  'activeVersion',a.active_version,'activeRevision',a.version) ORDER BY v.template_key,string_to_array(v.template_version,'.')::int[]),'[]'::jsonb) INTO items_arg
 FROM (SELECT * FROM public.company_data_template_versions WHERE tenant_id=tenant_arg ORDER BY template_key,string_to_array(template_version,'.')::int[] LIMIT 200) v
 LEFT JOIN public.company_data_template_active a ON a.tenant_id=v.tenant_id AND a.template_key=v.template_key;
 PERFORM public.oa_permission_admin_authority(session_arg);
 RETURN jsonb_build_object('items',items_arg,'truncated',count_arg>200,'platformCertification','LOCAL_GOLDEN_ONLY','liveVerified',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_company_data_template_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_company_data_template_list(uuid) TO oa_app;

CREATE FUNCTION public.oa_company_data_template_admin(
 operation_arg text,key_arg text,version_arg text,template_hash_arg text,certification_arg text,golden_hash_arg text,
 expected_arg bigint,review_arg text,request_arg uuid,session_arg uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant_arg uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor_arg uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 authority jsonb;prior public.company_data_template_requests%ROWTYPE;digest text;active_row public.company_data_template_active%ROWTYPE;
 version_row public.company_data_template_versions%ROWTYPE;result_arg jsonb;
BEGIN
 IF operation_arg IS NULL OR operation_arg NOT IN('PUBLISH','ROLLBACK') OR tenant_arg IS NULL OR actor_arg IS NULL OR request_arg IS NULL
  OR session_arg IS NULL OR key_arg IS NULL OR length(key_arg)>128 OR key_arg!~'^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$'
  OR version_arg IS NULL OR version_arg!~'^\d{1,4}\.\d{1,4}\.\d{1,4}$'
  OR review_arg IS NULL OR length(review_arg) NOT BETWEEN 8 AND 255 OR review_arg!~'^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  OR template_hash_arg IS NULL OR template_hash_arg!~'^[a-f0-9]{64}$' OR certification_arg IS NULL OR length(certification_arg) NOT BETWEEN 8 AND 255
  OR golden_hash_arg IS NULL OR golden_hash_arg!~'^[a-f0-9]{64}$'
  OR operation_arg='PUBLISH' AND expected_arg IS NOT NULL
  OR operation_arg='ROLLBACK' AND (expected_arg IS NULL OR expected_arg<1)
 THEN RAISE EXCEPTION 'COMPANY_DATA_TEMPLATE_INPUT_INVALID' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant_arg::text||':data-templates',0));
 authority=public.oa_permission_admin_authority(session_arg);
 digest=encode(sha256(convert_to(jsonb_build_object('operation',operation_arg,'key',key_arg,'version',version_arg,'templateHash',template_hash_arg,
  'certification',certification_arg,'goldenHash',golden_hash_arg,'expected',expected_arg,'review',review_arg)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.company_data_template_requests WHERE tenant_id=tenant_arg AND admin_id=actor_arg AND request_id=request_arg;
 IF FOUND THEN
  IF prior.args_hash<>digest THEN RAISE EXCEPTION 'COMPANY_DATA_TEMPLATE_REQUEST_CONFLICT' USING ERRCODE='40001';END IF;
  SELECT * INTO active_row FROM public.company_data_template_active WHERE tenant_id=tenant_arg AND template_key=prior.template_key;
  RETURN prior.result||jsonb_build_object('replayed',true,'currentActiveVersion',active_row.active_version,'currentActiveRevision',active_row.version);
 END IF;
 IF operation_arg='PUBLISH' THEN
  IF EXISTS(SELECT 1 FROM public.company_data_template_versions WHERE tenant_id=tenant_arg AND template_key=key_arg AND template_version=version_arg)
  THEN RAISE EXCEPTION 'COMPANY_DATA_TEMPLATE_VERSION_EXISTS' USING ERRCODE='23505';END IF;
  INSERT INTO public.company_data_template_versions(tenant_id,template_key,template_version,template_hash,certification_reference,golden_hash,published_by)
  VALUES(tenant_arg,key_arg,version_arg,template_hash_arg,certification_arg,golden_hash_arg,actor_arg);
  SELECT * INTO active_row FROM public.company_data_template_active WHERE tenant_id=tenant_arg AND template_key=key_arg FOR UPDATE;
  IF FOUND THEN
   UPDATE public.company_data_template_active SET active_version=version_arg,version=version+1,updated_by=actor_arg,updated_at=clock_timestamp()
   WHERE tenant_id=tenant_arg AND template_key=key_arg RETURNING * INTO active_row;
  ELSE
   INSERT INTO public.company_data_template_active(tenant_id,template_key,active_version,version,updated_by)
   VALUES(tenant_arg,key_arg,version_arg,1,actor_arg) RETURNING * INTO active_row;
  END IF;
 ELSE
  SELECT * INTO version_row FROM public.company_data_template_versions WHERE tenant_id=tenant_arg AND template_key=key_arg AND template_version=version_arg;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPANY_DATA_TEMPLATE_VERSION_UNKNOWN' USING ERRCODE='P0002';END IF;
  IF version_row.template_hash<>template_hash_arg OR version_row.certification_reference<>certification_arg OR version_row.golden_hash<>golden_hash_arg
  THEN RAISE EXCEPTION 'COMPANY_DATA_TEMPLATE_VERSION_MISMATCH' USING ERRCODE='40001';END IF;
  SELECT * INTO active_row FROM public.company_data_template_active WHERE tenant_id=tenant_arg AND template_key=key_arg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPANY_DATA_TEMPLATE_VERSION_UNKNOWN' USING ERRCODE='P0002';END IF;
  IF active_row.version<>expected_arg THEN RAISE EXCEPTION 'COMPANY_DATA_TEMPLATE_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
  UPDATE public.company_data_template_active SET active_version=version_arg,version=version+1,updated_by=actor_arg,updated_at=clock_timestamp()
  WHERE tenant_id=tenant_arg AND template_key=key_arg RETURNING * INTO active_row;
 END IF;
 result_arg=jsonb_build_object('templateKey',key_arg,'templateVersion',version_arg,'activeVersion',active_row.active_version,'activeRevision',active_row.version,
  'operation',operation_arg,'replayed',false,'requestId',request_arg,'platformCertification','LOCAL_GOLDEN_ONLY','liveVerified',false);
 INSERT INTO public.company_data_template_requests(tenant_id,admin_id,request_id,operation,template_key,template_version,args_hash,review_hash,result)
 VALUES(tenant_arg,actor_arg,request_arg,operation_arg,key_arg,version_arg,digest,encode(sha256(convert_to(review_arg,'UTF8')),'hex'),result_arg);
 PERFORM public.oa_permission_admin_authority(session_arg);
 IF NOT EXISTS(SELECT 1 FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=u.tenant_id
  WHERE s.tenant_id=tenant_arg AND s.owner_id=actor_arg AND s.id=session_arg AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  AND u.status='ACTIVE' AND t.status='ACTIVE' AND u.auth_epoch=s.auth_epoch)
 THEN RAISE EXCEPTION 'PERMISSION_SESSION_INVALID' USING ERRCODE='42501';END IF;
 RETURN result_arg;
END $$;
REVOKE ALL ON FUNCTION public.oa_company_data_template_admin(text,text,text,text,text,text,bigint,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_company_data_template_admin(text,text,text,text,text,text,bigint,text,uuid,uuid) TO oa_app;
