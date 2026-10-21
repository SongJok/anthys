-- No delegation, contract, platform permission or service is activated here.
-- Reviewed delegation is an operator-controlled application authority source;
-- it is never a claim that a local GROUP_ADMIN role proves platform ownership.
CREATE TABLE public.group_contract_delegations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,group_id text NOT NULL,administrator_id uuid NOT NULL,
 service_owner_id uuid NOT NULL,service_identity_id uuid NOT NULL,scope_id uuid NOT NULL,role_binding_id uuid NOT NULL,
 administrator_epoch bigint NOT NULL,service_owner_epoch bigint NOT NULL,role_version bigint NOT NULL,
 service_authorization_version bigint NOT NULL,scope_version bigint NOT NULL,policy_version text NOT NULL,
 currency text NOT NULL CHECK(currency IN ('CNY','USD')),max_amount_minor bigint NOT NULL CHECK(max_amount_minor>=0),
 valid_until timestamptz NOT NULL,review_reference text NOT NULL,source_review_hash text NOT NULL,
 document jsonb NOT NULL,document_hash text NOT NULL,operator_role text NOT NULL,
 revoked_at timestamptz,revoke_reference text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,administrator_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,service_identity_id,service_owner_id) REFERENCES public.dws_identities(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,scope_id,service_owner_id) REFERENCES public.dws_group_scopes(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,role_binding_id) REFERENCES public.role_bindings(tenant_id,id),
 CHECK(document_hash~'^[a-f0-9]{64}$' AND source_review_hash~'^[a-f0-9]{64}$'),
 CHECK((revoked_at IS NULL)=(revoke_reference IS NULL))
);
CREATE TABLE public.group_contracts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,group_id text NOT NULL,delegation_id uuid NOT NULL,
 current_revision_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN ('ACTIVE','PAUSED','REVOKED')),valid_from timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 currency text NOT NULL CHECK(currency IN ('CNY','USD')),max_amount_minor bigint NOT NULL CHECK(max_amount_minor>=0),
 allowed_actions jsonb NOT NULL,prohibited_actions jsonb NOT NULL,document_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,group_id),
 FOREIGN KEY(tenant_id,delegation_id) REFERENCES public.group_contract_delegations(tenant_id,id)
);
CREATE TABLE public.group_contract_revisions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,contract_id uuid NOT NULL,version bigint NOT NULL,
 administrator_id uuid NOT NULL,delegation_id uuid NOT NULL,state text NOT NULL,
 document_ref jsonb NOT NULL,document_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,contract_id,version),UNIQUE(tenant_id,id,contract_id),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES public.group_contracts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,delegation_id) REFERENCES public.group_contract_delegations(tenant_id,id),
 FOREIGN KEY(tenant_id,administrator_id) REFERENCES public.users(tenant_id,id)
);
ALTER TABLE public.group_contracts ADD FOREIGN KEY(tenant_id,current_revision_id,id) REFERENCES public.group_contract_revisions(tenant_id,id,contract_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.group_contract_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,administrator_id uuid NOT NULL,contract_id uuid NOT NULL,
 intent_hash text NOT NULL,revision_id uuid NOT NULL,version bigint NOT NULL,state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id,administrator_id),
 FOREIGN KEY(tenant_id,revision_id,contract_id) REFERENCES public.group_contract_revisions(tenant_id,id,contract_id)
);
ALTER TABLE public.group_contract_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_contract_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_contract_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY group_contract_tenant ON public.group_contracts USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY group_revision_tenant ON public.group_contract_revisions USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON public.group_contracts,public.group_contract_revisions TO oa_runtime;
CREATE FUNCTION public.oa_group_contract_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'GROUP_CONTRACT_HISTORY_IMMUTABLE';END $$;
CREATE TRIGGER group_revision_immutable BEFORE UPDATE OR DELETE ON public.group_contract_revisions FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
CREATE TRIGGER group_request_immutable BEFORE UPDATE OR DELETE ON public.group_contract_requests FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
REVOKE ALL ON FUNCTION public.oa_group_contract_immutable() FROM PUBLIC;
CREATE FUNCTION public.oa_group_delegation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL OR (to_jsonb(NEW)-ARRAY['revoked_at','revoke_reference']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revoke_reference'])
  OR NEW.revoked_at IS NULL OR NEW.revoke_reference IS NULL THEN RAISE EXCEPTION 'GROUP_DELEGATION_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER group_delegation_immutable BEFORE UPDATE OR DELETE ON public.group_contract_delegations FOR EACH ROW EXECUTE FUNCTION public.oa_group_delegation_immutable();
REVOKE ALL ON FUNCTION public.oa_group_delegation_immutable() FROM PUBLIC;
CREATE FUNCTION public.oa_group_contract_directory_hash(p_tenant uuid,p_scope uuid,p_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(g.id,g.tenant_id,g.owner_id,g.scope_id,g.open_dingtalk_id,g.user_id,g.external_user_id,g.user_auth_epoch,g.directory_authority_ref,to_char(g.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),g.version)::text,'UTF8')),'hex')
 FROM public.group_directory_bindings g JOIN public.users u ON u.tenant_id=g.tenant_id AND u.id=g.user_id
 WHERE g.tenant_id=p_tenant AND g.scope_id=p_scope AND g.user_id=p_user AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
  AND u.status='ACTIVE' AND g.user_auth_epoch=u.auth_epoch AND g.external_user_id=u.external_user_id AND g.open_dingtalk_id=u.open_dingtalk_id;
$$;
REVOKE ALL ON FUNCTION public.oa_group_contract_directory_hash(uuid,uuid,uuid) FROM PUBLIC;
CREATE FUNCTION public.oa_group_delegation_live(p_id uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.group_contract_delegations d
  JOIN public.users a ON a.tenant_id=d.tenant_id AND a.id=d.administrator_id
  JOIN public.users u ON u.tenant_id=d.tenant_id AND u.id=d.service_owner_id
  JOIN public.tenants t ON t.tenant_id=d.tenant_id
  JOIN public.role_bindings b ON b.tenant_id=d.tenant_id AND b.id=d.role_binding_id
  JOIN public.roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id
  JOIN public.dws_identities i ON i.tenant_id=d.tenant_id AND i.id=d.service_identity_id AND i.owner_id=u.id
  JOIN public.dws_group_scopes s ON s.tenant_id=d.tenant_id AND s.id=d.scope_id AND s.owner_id=u.id
  WHERE d.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND d.id=p_id AND d.revoked_at IS NULL AND d.valid_until>clock_timestamp()
   AND a.status='ACTIVE' AND u.status='ACTIVE' AND t.status='ACTIVE' AND t.policy_version=d.policy_version
   AND a.auth_epoch=d.administrator_epoch AND u.auth_epoch=d.service_owner_epoch
   AND b.subject_id=a.id AND b.scope_kind='GROUP' AND b.scope_id=d.group_id AND r.name='GROUP_ADMIN'
   AND b.version=d.role_version AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
   AND i.state='CONNECTED' AND i.auth_epoch=u.auth_epoch AND i.authorization_version=d.service_authorization_version
   AND i.delegation_expires_at>clock_timestamp() AND i.corp_id=t.corp_id AND i.external_user_id=u.external_user_id
   AND s.conversation_external_id=d.group_id AND s.version=d.scope_version AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.binary_hash=i.binary_hash
   AND public.oa_group_contract_directory_hash(d.tenant_id,d.scope_id,d.administrator_id)=d.document->>'administratorDirectoryHash');
$$;
REVOKE ALL ON FUNCTION public.oa_group_delegation_live(uuid) FROM PUBLIC;
CREATE FUNCTION public.oa_group_contract_authority(p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;d public.group_contract_delegations;
BEGIN
 IF nullif(current_setting('app.trial_profile_hash',true),'') IS NOT NULL OR nullif(current_setting('app.formal_profile_hash',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.one_shot_trials WHERE tenant_id=tenant) OR EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=tenant)
 THEN RAISE EXCEPTION 'GROUP_CONTRACT_LIFECYCLE_BLOCKED';END IF;
 SELECT * INTO d FROM public.group_contract_delegations WHERE tenant_id=tenant AND id=p_id AND administrator_id=actor;
 IF NOT FOUND OR NOT public.oa_group_delegation_live(p_id) THEN RAISE EXCEPTION 'GROUP_CONTRACT_AUTHORITY_REQUIRED';END IF;
 RETURN jsonb_build_object('id',d.id,'groupId',d.group_id,'administratorId',d.administrator_id,'serviceIdentityId',d.service_identity_id,'reviewReference',d.review_reference,'validUntil',d.valid_until,'currency',d.currency,'maxAmountMinor',d.max_amount_minor,'authority','REVIEWED_DELEGATION','platformPermissionsVerified',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_contract_authority(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_contract_authority(uuid) TO oa_runtime;
CREATE FUNCTION public.oa_group_contract_runtime(p_group text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;c public.group_contracts;allowed boolean;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=tenant AND u.id=nullif(current_setting('app.actor_id',true),'')::uuid AND u.status='ACTIVE' AND t.status='ACTIVE') THEN RETURN jsonb_build_object('mode','DENIED','allowed',false);END IF;
 SELECT * INTO c FROM public.group_contracts WHERE tenant_id=tenant AND group_id=p_group;
 IF NOT FOUND THEN RETURN jsonb_build_object('mode','NO_DELEGATION','allowed',true);END IF;
 allowed:=EXISTS(SELECT 1 FROM public.group_contract_delegations d WHERE d.tenant_id=tenant AND d.id=c.delegation_id AND d.service_owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) AND c.state='ACTIVE' AND c.valid_from<=clock_timestamp() AND c.expires_at>clock_timestamp() AND public.oa_group_delegation_live(c.delegation_id)
  AND c.allowed_actions ? 'question.answer' AND NOT c.prohibited_actions ? 'question.answer';
 RETURN jsonb_build_object('mode','CONTRACT','allowed',allowed,'id',c.id,'version',c.version,'hash',c.document_hash,'deadline',c.expires_at,'currency',c.currency,'maxAmountMinor',c.max_amount_minor,'administratorId',(SELECT administrator_id FROM public.group_contract_delegations WHERE tenant_id=tenant AND id=c.delegation_id));
END $$;
REVOKE ALL ON FUNCTION public.oa_group_contract_runtime(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_contract_runtime(text) TO oa_runtime;
CREATE FUNCTION public.oa_group_contract_delegate(p_document text,p_expected_hash text,p_review_ref text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE d jsonb;tenant uuid;admin_id uuid;service_id uuid;a public.users;u public.users;b public.role_bindings;i public.dws_identities;s public.dws_group_scopes;existing public.group_contract_delegations;digest text;last_at timestamptz;policy text;
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'GROUP_DELEGATION_MIGRATOR_REQUIRED';END IF;
 IF p_document IS NULL OR octet_length(p_document)>65536 THEN RAISE EXCEPTION 'GROUP_DELEGATION_DOCUMENT_INVALID';END IF;
 d:=p_document::jsonb;digest:=encode(sha256(convert_to(p_document,'UTF8')),'hex');
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR d->'approved' IS DISTINCT FROM 'true'::jsonb
  OR (SELECT count(*) FROM jsonb_object_keys(d))<>21 OR NOT d ?& ARRAY['id','tenantId','groupId','administratorId','serviceOwnerId','serviceIdentityId','scopeId','roleBindingId','administratorAuthEpoch','serviceOwnerAuthEpoch','roleVersion','serviceAuthorizationVersion','scopeVersion','validUntil','currency','maxAmountMinor','reviewReference','sourceReviewHash','schemaVersion','approved','administratorDirectoryHash']
  OR digest IS DISTINCT FROM p_expected_hash OR d->>'reviewReference' IS DISTINCT FROM p_review_ref
  OR p_review_ref IS NULL OR (length(p_review_ref)>512 OR p_review_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$') OR d->>'sourceReviewHash' !~ '^[a-f0-9]{64}$' OR d->>'administratorDirectoryHash' !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'GROUP_DELEGATION_EXACT_REVIEW_REQUIRED';END IF;
 tenant:=(d->>'tenantId')::uuid;admin_id:=(d->>'administratorId')::uuid;service_id:=(d->>'serviceOwnerId')::uuid;last_at:=(d->>'validUntil')::timestamptz;
 IF NOT isfinite(last_at) OR last_at<=clock_timestamp() OR d->>'currency' NOT IN ('CNY','USD') OR (d->>'maxAmountMinor')::numeric NOT BETWEEN 0 AND 9007199254740991 OR (d->>'maxAmountMinor')::numeric<>trunc((d->>'maxAmountMinor')::numeric) THEN RAISE EXCEPTION 'GROUP_DELEGATION_WINDOW_OR_BUDGET_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||(d->>'groupId'),0));
 SELECT * INTO a FROM public.users WHERE tenant_id=tenant AND id=admin_id AND status='ACTIVE' FOR SHARE;
 SELECT * INTO u FROM public.users WHERE tenant_id=tenant AND id=service_id AND status='ACTIVE' FOR SHARE;
 SELECT * INTO b FROM public.role_bindings WHERE tenant_id=tenant AND id=(d->>'roleBindingId')::uuid AND subject_id=admin_id AND scope_kind='GROUP' AND scope_id=d->>'groupId' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>=last_at) FOR SHARE;
 SELECT * INTO i FROM public.dws_identities WHERE tenant_id=tenant AND id=(d->>'serviceIdentityId')::uuid AND owner_id=service_id AND state='CONNECTED' AND delegation_expires_at>=last_at FOR SHARE;
 SELECT * INTO s FROM public.dws_group_scopes WHERE tenant_id=tenant AND id=(d->>'scopeId')::uuid AND owner_id=service_id AND conversation_external_id=d->>'groupId' AND revoked_at IS NULL AND expires_at>=last_at FOR SHARE;
 SELECT t.policy_version INTO policy FROM public.tenants t WHERE t.tenant_id=tenant AND t.status='ACTIVE' AND t.corp_id=i.corp_id;
 IF a.id IS NULL OR u.id IS NULL OR b.id IS NULL OR i.id IS NULL OR s.id IS NULL OR policy IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.roles WHERE tenant_id=tenant AND id=b.role_id AND name='GROUP_ADMIN')
  OR a.auth_epoch IS DISTINCT FROM (d->>'administratorAuthEpoch')::bigint OR u.auth_epoch IS DISTINCT FROM (d->>'serviceOwnerAuthEpoch')::bigint
  OR b.version IS DISTINCT FROM (d->>'roleVersion')::bigint OR i.authorization_version IS DISTINCT FROM (d->>'serviceAuthorizationVersion')::bigint OR s.version IS DISTINCT FROM (d->>'scopeVersion')::bigint
  OR public.oa_group_contract_directory_hash(tenant,s.id,admin_id) IS DISTINCT FROM d->>'administratorDirectoryHash'
  OR NOT EXISTS(SELECT 1 FROM public.group_directory_bindings g WHERE g.tenant_id=tenant AND g.scope_id=s.id AND g.user_id=admin_id AND g.revoked_at IS NULL AND g.expires_at>=last_at)
  OR i.auth_epoch<>u.auth_epoch OR i.external_user_id<>u.external_user_id OR i.binary_hash<>s.binary_hash
 THEN RAISE EXCEPTION 'GROUP_DELEGATION_SOURCE_CHANGED';END IF;
 SELECT * INTO existing FROM public.group_contract_delegations WHERE tenant_id=tenant AND id=(d->>'id')::uuid;
 IF FOUND THEN IF existing.document_hash=digest AND existing.revoked_at IS NULL AND existing.policy_version=policy THEN RETURN jsonb_build_object('id',existing.id,'replayed',true,'platformPermissionsVerified',false);END IF;RAISE EXCEPTION 'GROUP_DELEGATION_REPLAY_CONFLICT';END IF;
 INSERT INTO public.group_contract_delegations(tenant_id,id,group_id,administrator_id,service_owner_id,service_identity_id,scope_id,role_binding_id,administrator_epoch,service_owner_epoch,role_version,service_authorization_version,scope_version,policy_version,currency,max_amount_minor,valid_until,review_reference,source_review_hash,document,document_hash,operator_role)
 VALUES(tenant,(d->>'id')::uuid,d->>'groupId',admin_id,service_id,i.id,s.id,b.id,a.auth_epoch,u.auth_epoch,b.version,i.authorization_version,s.version,policy,d->>'currency',(d->>'maxAmountMinor')::bigint,last_at,p_review_ref,d->>'sourceReviewHash',d,digest,current_user);
 RETURN jsonb_build_object('id',d->>'id','replayed',false,'platformPermissionsVerified',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_contract_delegate(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_contract_delegate(text,text,text) TO oa_migrator;
CREATE FUNCTION public.oa_group_contract_delegation_revoke(p_id uuid,p_expected_hash text,p_reference text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.group_contract_delegations;
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'GROUP_DELEGATION_MIGRATOR_REQUIRED';END IF;
 IF p_reference IS NULL OR (length(p_reference)>512 OR p_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$') THEN RAISE EXCEPTION 'GROUP_DELEGATION_EXACT_REVIEW_REQUIRED';END IF;
 SELECT * INTO d FROM public.group_contract_delegations WHERE id=p_id AND document_hash=p_expected_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_DELEGATION_BINDING_MISMATCH';END IF;
 IF d.revoked_at IS NULL THEN UPDATE public.group_contract_delegations SET revoked_at=clock_timestamp(),revoke_reference=p_reference WHERE tenant_id=d.tenant_id AND id=d.id;END IF;
 RETURN jsonb_build_object('id',d.id,'state','REVOKED');
END $$;
REVOKE ALL ON FUNCTION public.oa_group_contract_delegation_revoke(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_contract_delegation_revoke(uuid,text,text) TO oa_migrator;
CREATE FUNCTION public.oa_group_contract_put(p_session uuid,p_delegation uuid,p_expected bigint,p_request uuid,p_intent_hash text,p_revision uuid,p_document text,p_cipher jsonb,p_document_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 d public.group_contract_delegations;old public.group_contracts;prior public.group_contract_requests;j jsonb;contract_id uuid;group_key text;next_version bigint;first_at timestamptz;last_at timestamptz;amount bigint;
BEGIN
 IF p_document IS NULL OR octet_length(p_document)>131072 OR p_revision IS NULL OR p_request IS NULL OR p_expected IS NULL OR p_expected<0 OR p_expected>=9007199254740991
  OR p_intent_hash IS NULL OR p_intent_hash !~ '^[a-f0-9]{64}$' OR p_document_hash IS DISTINCT FROM encode(sha256(convert_to(p_document,'UTF8')),'hex') OR jsonb_typeof(p_cipher) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'GROUP_CONTRACT_DOCUMENT_INVALID';END IF;
 PERFORM s.id FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=u.tenant_id
  WHERE s.tenant_id=tenant AND s.id=p_session AND s.owner_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='ACTIVE' AND t.status='ACTIVE' AND u.auth_epoch=s.auth_epoch;
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_CONTRACT_SESSION_INVALID';END IF;
 PERFORM public.oa_group_contract_authority(p_delegation);
 SELECT * INTO d FROM public.group_contract_delegations WHERE tenant_id=tenant AND id=p_delegation AND administrator_id=actor FOR SHARE;
 -- Serialize source revocation with the commit; no network I/O in this function.
 PERFORM 1 FROM public.role_bindings WHERE tenant_id=tenant AND id=d.role_binding_id FOR SHARE;
 -- Downscope stops must not wait behind a running worker's user/identity locks.
 -- They still require a current reviewed delegate and session; only ACTIVE
 -- grants pin all source rows. No source credential is used here.
 IF p_document::jsonb->>'state'='ACTIVE' THEN
  PERFORM 1 FROM public.users WHERE tenant_id=tenant AND id IN (actor,d.service_owner_id) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.dws_identities WHERE tenant_id=tenant AND id=d.service_identity_id FOR SHARE;
  PERFORM 1 FROM public.dws_group_scopes WHERE tenant_id=tenant AND id=d.scope_id FOR SHARE;
 END IF;
 IF NOT public.oa_group_delegation_live(p_delegation) THEN RAISE EXCEPTION 'GROUP_CONTRACT_AUTHORITY_REQUIRED';END IF;
 j:=p_document::jsonb;contract_id:=(j->>'id')::uuid;group_key:=j->>'groupId';next_version:=p_expected+1;
 IF j->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR j->>'tenantId' IS DISTINCT FROM tenant::text OR group_key IS DISTINCT FROM d.group_id
  OR j->>'serviceIdentityId' IS DISTINCT FROM d.service_identity_id::text OR j->'administratorAuthorization'->>'actorId' IS DISTINCT FROM actor::text
  OR j->'administratorAuthorization'->>'evidenceRef' IS DISTINCT FROM d.review_reference OR (j->>'version')::bigint IS DISTINCT FROM next_version
  OR j->>'state' NOT IN ('ACTIVE','PAUSED','REVOKED') OR coalesce(j->'sources'->>'mode','MENTION_ONLY')<>'MENTION_ONLY' OR j->'sources' ? 'enhanced'
  OR jsonb_typeof(j->'actions'->'allowed') IS DISTINCT FROM 'array' OR jsonb_typeof(j->'actions'->'prohibited') IS DISTINCT FROM 'array'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(j->'actions'->'allowed') a WHERE jsonb_typeof(a)<>'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(j->'actions'->'prohibited') a WHERE jsonb_typeof(a)<>'string')
  OR j->>'allowMentionAll' IS NOT NULL AND j->'allowMentionAll' IS DISTINCT FROM 'false'::jsonb
 THEN RAISE EXCEPTION 'GROUP_CONTRACT_BINDING_MISMATCH';END IF;
 first_at:=(j->>'validFrom')::timestamptz;last_at:=(j->>'expiresAt')::timestamptz;amount:=(j->'budget'->>'maxAmountMinor')::bigint;
 IF first_at IS NULL OR last_at IS NULL OR NOT isfinite(first_at) OR NOT isfinite(last_at) OR last_at<=first_at OR last_at>d.valid_until
  OR amount IS NULL OR amount<0 OR amount>d.max_amount_minor OR j->'budget'->>'currency' IS DISTINCT FROM d.currency
 THEN RAISE EXCEPTION 'GROUP_CONTRACT_WINDOW_OR_BUDGET_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||group_key,0));
 SELECT * INTO old FROM public.group_contracts WHERE tenant_id=tenant AND group_contracts.group_id=group_key FOR UPDATE;
 SELECT * INTO prior FROM public.group_contract_requests WHERE tenant_id=tenant AND id=p_request AND administrator_id=actor;
 IF FOUND THEN
  IF prior.intent_hash IS DISTINCT FROM p_intent_hash OR prior.contract_id IS DISTINCT FROM contract_id THEN RAISE EXCEPTION 'GROUP_CONTRACT_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('id',prior.contract_id,'revisionId',prior.revision_id,'version',prior.version,'state',prior.state,'replayed',true,'currentVersion',old.version,'currentState',CASE WHEN old.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE old.state END,'platformPermissionsVerified',false);
 END IF;
 IF coalesce(old.version,0)<>p_expected THEN RAISE EXCEPTION 'GROUP_CONTRACT_VERSION_CONFLICT';END IF;
 IF old.id IS NOT NULL AND (old.id<>contract_id OR old.currency<>d.currency) THEN RAISE EXCEPTION 'GROUP_CONTRACT_BINDING_MISMATCH';END IF;
 IF old.state='REVOKED' AND old.delegation_id=d.id THEN RAISE EXCEPTION 'GROUP_CONTRACT_FRESH_DELEGATION_REQUIRED';END IF;
 INSERT INTO public.group_contract_revisions(tenant_id,id,contract_id,version,administrator_id,delegation_id,state,document_ref,document_hash)
  VALUES(tenant,p_revision,contract_id,next_version,actor,d.id,j->>'state',p_cipher,p_document_hash);
 INSERT INTO public.group_contracts(tenant_id,id,group_id,delegation_id,current_revision_id,version,state,valid_from,expires_at,currency,max_amount_minor,allowed_actions,prohibited_actions,document_hash)
  VALUES(tenant,contract_id,group_key,d.id,p_revision,next_version,j->>'state',first_at,last_at,d.currency,amount,j->'actions'->'allowed',j->'actions'->'prohibited',p_document_hash)
  ON CONFLICT(tenant_id,group_id) DO UPDATE SET delegation_id=excluded.delegation_id,current_revision_id=excluded.current_revision_id,version=excluded.version,state=excluded.state,valid_from=excluded.valid_from,expires_at=excluded.expires_at,currency=excluded.currency,max_amount_minor=excluded.max_amount_minor,allowed_actions=excluded.allowed_actions,prohibited_actions=excluded.prohibited_actions,document_hash=excluded.document_hash,updated_at=clock_timestamp();
 INSERT INTO public.group_contract_requests(tenant_id,id,administrator_id,contract_id,intent_hash,revision_id,version,state) VALUES(tenant,p_request,actor,contract_id,p_intent_hash,p_revision,next_version,j->>'state');
 RETURN jsonb_build_object('id',contract_id,'revisionId',p_revision,'version',next_version,'state',j->>'state','replayed',false,'currentVersion',next_version,'currentState',CASE WHEN last_at<=clock_timestamp() THEN 'EXPIRED' ELSE j->>'state' END,'platformPermissionsVerified',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_contract_put(uuid,uuid,bigint,uuid,text,uuid,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_contract_put(uuid,uuid,bigint,uuid,text,uuid,text,jsonb,text) TO oa_runtime;
ALTER TABLE public.budget_buckets DROP CONSTRAINT budget_buckets_scope_kind_check;
ALTER TABLE public.budget_buckets ADD CHECK(scope_kind IN ('TENANT','GROUP','DEPARTMENT','USER','TASK'));
