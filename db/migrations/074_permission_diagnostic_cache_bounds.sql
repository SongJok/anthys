-- Bounded owner-local diagnostic cache; no authority, grant or credential changes.
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
