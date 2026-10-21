-- Local group transactions only. No history reading, notification or delegation
-- is activated by this migration. Existing contracts must explicitly allow cases.
CREATE FUNCTION public.oa_group_case_member(p_group text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.group_contracts c
 JOIN public.group_contract_delegations d ON d.tenant_id=c.tenant_id AND d.id=c.delegation_id
 JOIN public.group_directory_bindings b ON b.tenant_id=d.tenant_id AND b.scope_id=d.scope_id
 JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.user_id
 WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND c.group_id=p_group
 AND c.state='ACTIVE' AND c.valid_from<=clock_timestamp() AND c.expires_at>clock_timestamp()
 AND public.oa_group_delegation_live(c.delegation_id)
 AND b.user_id=nullif(current_setting('app.actor_id',true),'')::uuid
 AND b.revoked_at IS NULL AND b.expires_at>clock_timestamp() AND u.status='ACTIVE'
 AND b.user_auth_epoch=u.auth_epoch AND b.external_user_id=u.external_user_id AND b.open_dingtalk_id=u.open_dingtalk_id);
$$;
REVOKE ALL ON FUNCTION public.oa_group_case_member(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_member(text) TO oa_runtime;

CREATE FUNCTION public.oa_group_case_authority(p_group text,p_session uuid,p_action text,p_version bigint) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;c public.group_contracts;d public.group_contract_delegations;
BEGIN
 IF nullif(current_setting('app.trial_profile_hash',true),'') IS NOT NULL OR nullif(current_setting('app.formal_profile_hash',true),'') IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.one_shot_trials WHERE tenant_id=tenant) OR EXISTS(SELECT 1 FROM public.formal_authorizations WHERE tenant_id=tenant)
 THEN RAISE EXCEPTION 'GROUP_CASE_LIFECYCLE_BLOCKED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id
 WHERE s.tenant_id=tenant AND s.id=p_session AND s.owner_id=actor AND s.auth_epoch=u.auth_epoch AND u.status='ACTIVE'
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'GROUP_CASE_SESSION_INVALID';END IF;
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
REVOKE ALL ON FUNCTION public.oa_group_case_authority(text,uuid,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_authority(text,uuid,text,bigint) TO oa_runtime;

CREATE TABLE public.group_cases (
 tenant_id uuid NOT NULL,id uuid NOT NULL,group_id text NOT NULL,contract_id uuid NOT NULL,
 contract_version bigint NOT NULL,created_by uuid NOT NULL,owner_id uuid,
 state text NOT NULL CHECK(state IN ('PROPOSED','OPEN','ASSIGNED','IN_PROGRESS','BLOCKED','WAITING_CONFIRMATION','RESOLVED','CLOSED','CANCELLED')),
 resource_hash text NOT NULL CHECK(resource_hash~'^[a-f0-9]{64}$'),payload_ref jsonb NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,group_id),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES public.group_contracts(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES public.users(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id)
);
CREATE TABLE public.group_case_sources (
 tenant_id uuid NOT NULL,id uuid NOT NULL,group_id text NOT NULL,case_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('MENTION','CARD')),source_key text NOT NULL,
 source_event_id uuid,submitted_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,group_id,source_key),
 FOREIGN KEY(tenant_id,case_id,group_id) REFERENCES public.group_cases(tenant_id,id,group_id),
 FOREIGN KEY(tenant_id,source_event_id) REFERENCES public.event_inbox(tenant_id,id),
 FOREIGN KEY(tenant_id,submitted_by) REFERENCES public.users(tenant_id,id),
 CHECK((kind='MENTION')=(source_event_id IS NOT NULL))
);
CREATE TABLE public.group_case_changes (
 tenant_id uuid NOT NULL,id uuid NOT NULL,group_id text NOT NULL,case_id uuid NOT NULL,actor_id uuid NOT NULL,
 contract_version bigint NOT NULL,case_version bigint NOT NULL,intent_hash text NOT NULL,
 operation text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id,actor_id),UNIQUE(tenant_id,case_id,case_version),
 FOREIGN KEY(tenant_id,case_id,group_id) REFERENCES public.group_cases(tenant_id,id,group_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES public.users(tenant_id,id)
);
CREATE INDEX group_cases_group_updated ON public.group_cases(tenant_id,group_id,updated_at,id);
CREATE INDEX group_cases_resource ON public.group_cases(tenant_id,group_id,resource_hash);
CREATE TABLE public.group_case_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,group_id text NOT NULL,case_id uuid NOT NULL,
 intent_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id,actor_id),
 FOREIGN KEY(tenant_id,case_id,group_id) REFERENCES public.group_cases(tenant_id,id,group_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES public.users(tenant_id,id)
);
ALTER TABLE public.group_case_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_case_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_case_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_case_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_case_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_case_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY group_cases_member ON public.group_cases USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_group_case_member(group_id)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_group_case_member(group_id));
CREATE POLICY group_case_sources_member ON public.group_case_sources USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_group_case_member(group_id)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_group_case_member(group_id));
CREATE POLICY group_case_changes_member ON public.group_case_changes USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_group_case_member(group_id)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND public.oa_group_case_member(group_id));
CREATE POLICY group_case_requests_member ON public.group_case_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_group_case_member(group_id)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND public.oa_group_case_member(group_id));
GRANT SELECT,INSERT,UPDATE ON public.group_cases TO oa_runtime;
GRANT SELECT,INSERT ON public.group_case_sources,public.group_case_changes TO oa_runtime;
GRANT SELECT,INSERT ON public.group_case_requests TO oa_runtime;
CREATE TRIGGER group_case_source_immutable BEFORE UPDATE OR DELETE ON public.group_case_sources FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
CREATE TRIGGER group_case_change_immutable BEFORE UPDATE OR DELETE ON public.group_case_changes FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
CREATE TRIGGER group_case_request_immutable BEFORE UPDATE OR DELETE ON public.group_case_requests FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
