-- Native mentions use their actual task/run origin, never a fabricated H5 session.
ALTER TABLE tasks DROP CONSTRAINT tasks_control_kind_check;
ALTER TABLE tasks ADD CHECK(control_kind IN ('STOP','CLARIFICATION_REPLY','PERSONA','MEMORY','REMINDER','SCHEDULE','GROUP_CASE'));
CREATE FUNCTION public.oa_group_case_native_authority(p_group text,p_task uuid,p_run uuid,p_action text,p_version bigint) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;c public.group_contracts;d public.group_contract_delegations;
BEGIN
 IF nullif(current_setting('app.trial_profile_hash',true),'') IS NOT NULL OR nullif(current_setting('app.formal_profile_hash',true),'') IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.one_shot_trials WHERE tenant_id=tenant) OR EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=tenant)
 THEN RAISE EXCEPTION 'GROUP_CASE_LIFECYCLE_BLOCKED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tasks t JOIN public.runs r ON r.tenant_id=t.tenant_id AND r.task_id=t.id AND r.owner_id=t.requester_id
 JOIN public.users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN public.tenants org ON org.tenant_id=t.tenant_id
 JOIN public.conversations v ON v.tenant_id=t.tenant_id AND v.id=t.conversation_id
 JOIN public.event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id AND e.owner_id=t.requester_id
 WHERE t.tenant_id=tenant AND t.id=p_task AND r.id=p_run AND t.requester_id=actor AND t.control_kind='GROUP_CASE'
 AND t.status IN ('ACTIVE','COMPLETED') AND r.status IN ('RUNNING','SUCCEEDED','PARTIAL') AND t.cancel_requested_at IS NULL
 AND t.expires_at>clock_timestamp() AND t.auth_epoch=u.auth_epoch AND u.status='ACTIVE' AND org.status='ACTIVE'
 AND v.kind='GROUP' AND v.source_mode='MENTION_ONLY' AND v.external_id=p_group AND e.source='DINGTALK' AND e.state IN ('ENQUEUED','PROCESSED'))
 THEN RAISE EXCEPTION 'GROUP_CASE_NATIVE_INVALID';END IF;
 -- Same lock as contract updates: a pause/revoke committed first vetoes this
 -- transaction; once this transaction commits, the next read still rechecks.
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||p_group,0));
 IF NOT public.oa_group_case_member(p_group) THEN RAISE EXCEPTION 'GROUP_CASE_NOT_FOUND';END IF;
 SELECT * INTO c FROM public.group_contracts WHERE tenant_id=tenant AND group_id=p_group;
 IF p_version IS NOT NULL AND c.version<>p_version THEN RAISE EXCEPTION 'GROUP_CASE_CONTRACT_CONFLICT';END IF;
 IF p_action NOT IN ('case.read','case.create','case.update') OR NOT c.allowed_actions ? p_action OR c.prohibited_actions ? p_action THEN RAISE EXCEPTION 'GROUP_CASE_ACTION_DENIED';END IF;
 SELECT * INTO d FROM public.group_contract_delegations WHERE tenant_id=tenant AND id=c.delegation_id;
 RETURN jsonb_build_object('contractId',c.id,'contractVersion',c.version,'scopeId',d.scope_id,
 'administrator',d.administrator_id=actor,'ownerReportedAllowed',c.allowed_actions ? 'case.owner_reported' AND NOT c.prohibited_actions ? 'case.owner_reported');
END $$;
REVOKE ALL ON FUNCTION public.oa_group_case_native_authority(text,uuid,uuid,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_native_authority(text,uuid,uuid,text,bigint) TO oa_runtime;

CREATE FUNCTION public.oa_group_case_native_members(p_group text,p_task uuid,p_run uuid) RETURNS TABLE(id uuid,name text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;
BEGIN
 a:=public.oa_group_case_native_authority(p_group,p_task,p_run,'case.read',NULL);
 RETURN QUERY SELECT b.user_id,u.display_name FROM public.group_directory_bindings b
 JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.user_id
 WHERE b.tenant_id=tenant AND b.scope_id=(a->>'scopeId')::uuid AND b.revoked_at IS NULL
 AND b.expires_at>clock_timestamp() AND u.status='ACTIVE' AND b.user_auth_epoch=u.auth_epoch
 AND b.external_user_id=u.external_user_id AND b.open_dingtalk_id=u.open_dingtalk_id
 ORDER BY b.user_id LIMIT 2000;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_case_native_members(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_native_members(text,uuid,uuid) TO oa_runtime;

CREATE TABLE group_case_responses (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,group_id text NOT NULL,task_id uuid NOT NULL,run_id uuid NOT NULL,event_id uuid NOT NULL,
 proof_ref jsonb NOT NULL,proof_hash text NOT NULL,content_hash text NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,run_id),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,event_id) REFERENCES event_inbox(tenant_id,id)
);
ALTER TABLE group_case_responses ENABLE ROW LEVEL SECURITY;ALTER TABLE group_case_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY group_case_response_owner ON group_case_responses USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON group_case_responses TO oa_runtime;
CREATE TRIGGER group_case_response_immutable BEFORE UPDATE OR DELETE ON group_case_responses FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
