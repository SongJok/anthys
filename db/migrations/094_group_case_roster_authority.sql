-- Metadata for one authenticated H5 case operation. This never exposes credentials,
-- activates a contract or treats an identity mapping as current group membership.
CREATE FUNCTION public.oa_group_case_observer(p_group text,p_session uuid,p_action text,p_version bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;result jsonb;
BEGIN
 a:=public.oa_group_case_authority(p_group,p_session,p_action,p_version);
 SELECT jsonb_build_object(
  'authority',a,'contractHash',c.document_hash,'revisionId',c.current_revision_id,
  'delegationId',d.id,'delegationHash',d.document_hash,'administratorId',d.administrator_id,
  'serviceOwnerId',d.service_owner_id,'identityId',d.service_identity_id,
  'ownerAuthEpoch',u.auth_epoch,'authorizationVersion',i.authorization_version,
  'subject',jsonb_build_object('corpId',i.corp_id,'userId',i.external_user_id),
  'policyVersion',t.policy_version,'scopeVersion',s.version,
  'scopeExpiresAt',s.expires_at,'contractExpiresAt',c.expires_at,
  'sessionAuthEpoch',se.auth_epoch,'sessionExpiresAt',se.expires_at,
  'profile',s.info_profile,'approvedBots',s.approved_bots,
  'binaryHash',s.binary_hash,'membersSchemaHash',s.members_schema_hash,
  'infoSchemaHash',s.info_schema_hash,'contractSchemaHash',s.contract_hash,
  'scopeReview',s.authorization_review_ref,'directoryReview',s.directory_review_ref,
  'grantBindings',(SELECT jsonb_agg(jsonb_build_object('id',g.id,'expiresAt',g.expires_at,'classification',g.classification_ceiling) ORDER BY g.id)
   FROM public.resource_grants g WHERE g.tenant_id=tenant AND g.actor_id=d.service_owner_id
   AND g.capability_id='dws.group.audience' AND g.resource_id='dingtalk:group:'||p_group
   AND g.audience_kind='PRIVATE_USER' AND g.audience_id=d.service_owner_id::text
   AND g.classification_ceiling IN ('INTERNAL','CONFIDENTIAL','RESTRICTED') AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()))
 INTO result FROM public.group_contracts c
 JOIN public.group_contract_delegations d ON d.tenant_id=c.tenant_id AND d.id=c.delegation_id
 JOIN public.users u ON u.tenant_id=d.tenant_id AND u.id=d.service_owner_id
 JOIN public.tenants t ON t.tenant_id=c.tenant_id
 JOIN public.dws_identities i ON i.tenant_id=d.tenant_id AND i.id=d.service_identity_id AND i.owner_id=d.service_owner_id
 JOIN public.dws_group_scopes s ON s.tenant_id=d.tenant_id AND s.id=d.scope_id AND s.owner_id=d.service_owner_id
 JOIN public.sessions se ON se.tenant_id=c.tenant_id AND se.id=p_session AND se.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid
 WHERE c.tenant_id=tenant AND c.group_id=p_group AND c.id=(a->>'contractId')::uuid
 AND i.model_egress_allowed AND public.oa_group_delegation_live(d.id)
 AND EXISTS(SELECT 1 FROM public.resource_grants g WHERE g.tenant_id=tenant AND g.actor_id=d.service_owner_id
  AND g.capability_id='dws.group.audience' AND g.resource_id='dingtalk:group:'||p_group
  AND g.audience_kind='PRIVATE_USER' AND g.audience_id=d.service_owner_id::text
  AND g.classification_ceiling IN ('INTERNAL','CONFIDENTIAL','RESTRICTED') AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp());
 IF result IS NULL THEN RAISE EXCEPTION 'GROUP_CASE_ROSTER_UNAVAILABLE';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_case_observer(text,uuid,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_observer(text,uuid,text,bigint) TO oa_runtime;

-- Only identities present in a fresh, validated remote observation are projected.
-- The application supplies the observation, checks all aliases, then checks it
-- again after the case read/write. An arbitrary list is never an HTTP input.
CREATE FUNCTION public.oa_group_case_observed_members(p_group text,p_session uuid,p_action text,p_version bigint,p_open_ids text[]) RETURNS TABLE(id uuid,name text,open_id text,binding jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;
BEGIN
 a:=public.oa_group_case_authority(p_group,p_session,p_action,p_version);
 IF p_open_ids IS NULL OR cardinality(p_open_ids) NOT BETWEEN 1 AND 2000
 OR cardinality(p_open_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_open_ids) x)
 OR EXISTS(SELECT 1 FROM unnest(p_open_ids) x WHERE x IS NULL OR length(x) NOT BETWEEN 1 AND 256)
 THEN RAISE EXCEPTION 'GROUP_CASE_ROSTER_UNAVAILABLE';END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_open_ids) x WHERE
  (SELECT count(*) FROM public.users u WHERE u.tenant_id=tenant AND u.open_dingtalk_id=x AND u.status='ACTIVE')<>1)
 THEN RAISE EXCEPTION 'GROUP_CASE_ROSTER_UNAVAILABLE';END IF;
 RETURN QUERY SELECT b.user_id,u.display_name,b.open_dingtalk_id,
 jsonb_build_array(b.id,b.version,b.user_id,b.open_dingtalk_id,b.external_user_id,b.user_auth_epoch,b.directory_authority_ref,b.expires_at,u.auth_epoch)
 FROM public.group_directory_bindings b JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.user_id
 WHERE b.tenant_id=tenant AND b.scope_id=(a->>'scopeId')::uuid AND b.open_dingtalk_id=ANY(p_open_ids)
 AND b.revoked_at IS NULL AND b.expires_at>clock_timestamp() AND u.status='ACTIVE'
 AND b.user_auth_epoch=u.auth_epoch AND b.external_user_id=u.external_user_id AND b.open_dingtalk_id=u.open_dingtalk_id
 ORDER BY b.open_dingtalk_id,b.id;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_case_observed_members(text,uuid,text,bigint,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_observed_members(text,uuid,text,bigint,text[]) TO oa_runtime;

-- H5 roster reads hold the same contract advisory lock before credential refresh.
-- ACTIVE contract puts must take that lock before identity/source FOR SHARE locks,
-- otherwise a put and a roster read can wait on each other's separate connections.
-- Retain the complete v85 validation body behind a non-runtime-callable wrapper.
ALTER FUNCTION public.oa_group_contract_put(uuid,uuid,bigint,uuid,text,uuid,text,jsonb,text) RENAME TO oa_group_contract_put_v85;
REVOKE ALL ON FUNCTION public.oa_group_contract_put_v85(uuid,uuid,bigint,uuid,text,uuid,text,jsonb,text) FROM PUBLIC,oa_runtime;
CREATE FUNCTION public.oa_group_contract_put(p_session uuid,p_delegation uuid,p_expected bigint,p_request uuid,p_intent_hash text,p_revision uuid,p_document text,p_cipher jsonb,p_document_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;group_key text;
BEGIN
 IF p_document IS NULL OR octet_length(p_document)>131072 OR jsonb_typeof(p_document::jsonb) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_document::jsonb->'groupId') IS DISTINCT FROM 'string'
 THEN RAISE EXCEPTION 'GROUP_CONTRACT_DOCUMENT_INVALID';END IF;
 group_key:=p_document::jsonb->>'groupId';
 IF length(group_key) NOT BETWEEN 1 AND 2048 THEN RAISE EXCEPTION 'GROUP_CONTRACT_DOCUMENT_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||group_key,0));
 RETURN public.oa_group_contract_put_v85(p_session,p_delegation,p_expected,p_request,p_intent_hash,p_revision,p_document,p_cipher,p_document_hash);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_contract_put(uuid,uuid,bigint,uuid,text,uuid,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_contract_put(uuid,uuid,bigint,uuid,text,uuid,text,jsonb,text) TO oa_runtime;

-- Retired full-directory projections cannot accidentally be reused as membership.
REVOKE ALL ON FUNCTION public.oa_group_case_members(text,uuid) FROM PUBLIC,oa_runtime;
REVOKE ALL ON FUNCTION public.oa_group_case_native_members(text,uuid,uuid) FROM PUBLIC,oa_runtime;
