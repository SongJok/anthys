-- Separate references preserve the original owner-only audience/dependency FKs.
CREATE TABLE public.run_native_case_audiences (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,task_id uuid NOT NULL,
 service_owner_id uuid NOT NULL,identity_id uuid NOT NULL,authorization_version bigint NOT NULL CHECK(authorization_version>0),
 scope_id uuid NOT NULL,scope_version bigint NOT NULL CHECK(scope_version>0),contract_id uuid NOT NULL,
 worker_id uuid NOT NULL,fence bigint NOT NULL CHECK(fence>0),
 proof_ref jsonb NOT NULL,proof_hash text NOT NULL CHECK(proof_hash~'^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,run_id,owner_id),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES public.runs(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES public.tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,service_owner_id) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,identity_id,service_owner_id) REFERENCES public.dws_identities(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,scope_id,service_owner_id) REFERENCES public.dws_group_scopes(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES public.group_contracts(tenant_id,id)
);
ALTER TABLE public.run_native_case_audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_native_case_audiences FORCE ROW LEVEL SECURITY;
CREATE POLICY native_case_owner ON public.run_native_case_audiences USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.run_native_case_audiences TO oa_runtime;
CREATE TRIGGER native_case_audience_immutable BEFORE UPDATE OR DELETE ON public.run_native_case_audiences FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
ALTER TABLE public.runs ADD COLUMN native_case_audience_id uuid;
ALTER TABLE public.runs ADD FOREIGN KEY(tenant_id,native_case_audience_id,id,owner_id) REFERENCES public.run_native_case_audiences(tenant_id,id,run_id,owner_id);
ALTER TABLE public.runs ADD CHECK(group_audience_id IS NULL OR native_case_audience_id IS NULL);

-- Native group cases retain the requesting member and reviewed credential owner
-- as separate principals. No H5 session, owner lease or model permission is inferred.
CREATE FUNCTION public.oa_group_case_native_observer(p_group text,p_task uuid,p_run uuid,p_worker uuid,p_fence bigint,p_phase text,p_action text,p_version bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;a jsonb;result jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||p_group,0));
 IF p_worker IS NULL OR p_fence IS NULL OR p_fence<1 OR p_phase IS NULL OR p_phase NOT IN ('EXECUTION','RESULT_VERIFICATION')
 OR p_action IS NULL OR p_action NOT IN ('case.read','case.create','case.update')
 OR p_phase='RESULT_VERIFICATION' AND p_action<>'case.read'
 OR NOT EXISTS(SELECT 1 FROM public.runs r JOIN public.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=r.owner_id
 WHERE r.tenant_id=tenant AND r.id=p_run AND r.task_id=p_task AND r.owner_id=actor AND r.fence=p_fence
 AND t.control_kind='GROUP_CASE' AND t.cancel_requested_at IS NULL AND t.expires_at>clock_timestamp()
 AND public.oa_lifecycle_run_allowed(r.id) AND NOT public.oa_run_content_erased(r.id)
 AND (p_phase='EXECUTION' AND r.status='RUNNING' AND t.status='ACTIVE' AND r.lease_owner=p_worker::text AND r.lease_until>clock_timestamp()
 OR p_phase='RESULT_VERIFICATION' AND r.status='SUCCEEDED' AND t.status='COMPLETED'
 AND EXISTS(SELECT 1 FROM public.run_native_case_audiences q JOIN public.group_case_responses response ON response.tenant_id=q.tenant_id AND response.run_id=q.run_id AND response.owner_id=q.owner_id AND response.task_id=q.task_id
 WHERE q.tenant_id=tenant AND q.run_id=r.id AND q.id=r.native_case_audience_id AND q.owner_id=actor AND q.worker_id=p_worker AND q.fence=p_fence AND q.expires_at>clock_timestamp())))
 THEN RAISE EXCEPTION 'GROUP_CASE_NATIVE_LEASE_LOST';END IF;
 a:=public.oa_group_case_native_authority(p_group,p_task,p_run,p_action,p_version);
 SELECT jsonb_build_object(
  'authority',a,'contractHash',c.document_hash,'revisionId',c.current_revision_id,
  'delegationId',d.id,'delegationHash',d.document_hash,'administratorId',d.administrator_id,
  'serviceOwnerId',d.service_owner_id,'identityId',d.service_identity_id,
  'ownerAuthEpoch',u.auth_epoch,'authorizationVersion',i.authorization_version,
  'subject',jsonb_build_object('corpId',i.corp_id,'userId',i.external_user_id),
  'policyVersion',t.policy_version,'scopeVersion',s.version,
  'scopeExpiresAt',s.expires_at,'contractExpiresAt',c.expires_at,
  'requesterAuthEpoch',req.auth_epoch,'requesterDeadline',least(task.expires_at,s.expires_at,c.expires_at,d.valid_until,i.delegation_expires_at),
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
 JOIN public.tasks task ON task.tenant_id=c.tenant_id AND task.id=p_task AND task.requester_id=actor
 JOIN public.users req ON req.tenant_id=task.tenant_id AND req.id=actor
 WHERE c.tenant_id=tenant AND c.group_id=p_group AND c.id=(a->>'contractId')::uuid
 AND i.model_egress_allowed AND public.oa_group_delegation_live(d.id)
 AND EXISTS(SELECT 1 FROM public.resource_grants g WHERE g.tenant_id=tenant AND g.actor_id=d.service_owner_id
  AND g.capability_id='dws.group.audience' AND g.resource_id='dingtalk:group:'||p_group
  AND g.audience_kind='PRIVATE_USER' AND g.audience_id=d.service_owner_id::text
  AND g.classification_ceiling IN ('INTERNAL','CONFIDENTIAL','RESTRICTED') AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp());
 IF result IS NULL THEN RAISE EXCEPTION 'GROUP_CASE_ROSTER_UNAVAILABLE';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_case_native_observer(text,uuid,uuid,uuid,bigint,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_native_observer(text,uuid,uuid,uuid,bigint,text,text,bigint) TO oa_runtime;

CREATE FUNCTION public.oa_group_case_native_observed_members(p_group text,p_task uuid,p_run uuid,p_worker uuid,p_fence bigint,p_phase text,p_action text,p_version bigint,p_open_ids text[]) RETURNS TABLE(id uuid,name text,open_id text,binding jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;
BEGIN
 a:=(public.oa_group_case_native_observer(p_group,p_task,p_run,p_worker,p_fence,p_phase,p_action,p_version))->'authority';
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
REVOKE ALL ON FUNCTION public.oa_group_case_native_observed_members(text,uuid,uuid,uuid,bigint,text,text,bigint,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_native_observed_members(text,uuid,uuid,uuid,bigint,text,text,bigint,text[]) TO oa_runtime;


-- A nonlocking MVCC stop observation, not execution or sending authority. It
-- cannot wait on the contract/user locks held by its own guarded case operation.
CREATE FUNCTION public.oa_group_case_native_watch(p_run uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT coalesce((SELECT jsonb_build_object('mode','CONTRACT',
  'allowed',public.oa_group_case_member(v.external_id) AND t.cancel_requested_at IS NULL
   AND t.status IN ('ACTIVE','COMPLETED') AND r.status IN ('RUNNING','SUCCEEDED')
   AND t.expires_at>clock_timestamp() AND t.auth_epoch=u.auth_epoch AND u.status='ACTIVE' AND org.status='ACTIVE'
   AND org.policy_version=d.policy_version AND NOT public.oa_run_content_erased(r.id)
   AND nullif(current_setting('app.trial_profile_hash',true),'') IS NULL AND nullif(current_setting('app.formal_profile_hash',true),'') IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.one_shot_trials slot WHERE slot.tenant_id=t.tenant_id)
   AND NOT EXISTS(SELECT 1 FROM public.formal_authorizations auth WHERE auth.tenant_id=t.tenant_id),
  'id',c.id,'version',c.version,'hash',c.document_hash,'administratorId',d.administrator_id,
  'deadline',least(t.expires_at,c.expires_at,s.expires_at,d.valid_until,i.delegation_expires_at),
  'currency',c.currency,'maxAmountMinor',c.max_amount_minor)
 FROM public.runs r JOIN public.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=r.owner_id
 JOIN public.users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN public.tenants org ON org.tenant_id=t.tenant_id
 JOIN public.conversations v ON v.tenant_id=t.tenant_id AND v.id=t.conversation_id AND v.kind='GROUP' AND v.source_mode='MENTION_ONLY'
 JOIN public.event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id AND e.owner_id=t.requester_id AND e.source='DINGTALK'
 JOIN public.group_contracts c ON c.tenant_id=t.tenant_id AND c.group_id=v.external_id
 JOIN public.group_contract_delegations d ON d.tenant_id=c.tenant_id AND d.id=c.delegation_id
 JOIN public.dws_group_scopes s ON s.tenant_id=d.tenant_id AND s.id=d.scope_id AND s.owner_id=d.service_owner_id
 JOIN public.dws_identities i ON i.tenant_id=d.tenant_id AND i.id=d.service_identity_id AND i.owner_id=d.service_owner_id
 WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND r.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid
 AND r.id=p_run AND t.control_kind='GROUP_CASE' AND t.audience->>'kind'='GROUP' AND t.audience->>'targetId'=v.external_id),
 jsonb_build_object('mode','DENIED','allowed',false));
$$;
REVOKE ALL ON FUNCTION public.oa_group_case_native_watch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_native_watch(uuid) TO oa_runtime;
