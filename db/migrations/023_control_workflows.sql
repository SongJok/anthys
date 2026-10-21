ALTER TABLE role_bindings ADD COLUMN expires_at timestamptz,ADD COLUMN revoked_at timestamptz;
CREATE FUNCTION public.oa_role_binding_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.users SET auth_epoch=auth_epoch+1,version=version+1 WHERE tenant_id=OLD.tenant_id AND id=OLD.subject_id;
 IF TG_OP='UPDATE' THEN NEW.version=OLD.version+1;RETURN NEW;END IF;RETURN OLD;
END;$$;
CREATE TRIGGER role_binding_epoch BEFORE UPDATE OR DELETE ON role_bindings FOR EACH ROW EXECUTE FUNCTION public.oa_role_binding_epoch();
REVOKE ALL ON FUNCTION public.oa_role_binding_epoch() FROM PUBLIC;
ALTER TABLE tool_actions ADD COLUMN hash_version integer NOT NULL DEFAULT 1 CHECK(hash_version IN (1,2)),ADD COLUMN scope_descriptor jsonb,ADD COLUMN approval_preview jsonb,ADD COLUMN connector_id text,ADD COLUMN dispatch_started_at timestamptz;
ALTER TABLE tool_actions ADD UNIQUE(tenant_id,id,owner_id),ADD UNIQUE(tenant_id,id,run_id,owner_id);
ALTER TABLE approvals ADD COLUMN workflow_version integer NOT NULL DEFAULT 0 CHECK(workflow_version IN (0,1)),ADD COLUMN authority_id uuid,ADD COLUMN authority_version bigint,ADD COLUMN requester_auth_epoch bigint,ADD COLUMN nonce_session_id uuid,ADD COLUMN nonce_expires_at timestamptz,ADD COLUMN decided_session_id uuid,ADD COLUMN consumed_attempt_id uuid;
ALTER TABLE approvals DROP CONSTRAINT approvals_state_check;
ALTER TABLE approvals ADD CHECK(state IN ('PENDING','APPROVED','REJECTED','CONSUMED','EXPIRED','INVALIDATED'));
ALTER TABLE approvals ADD FOREIGN KEY(tenant_id,action_id,owner_id) REFERENCES tool_actions(tenant_id,id,owner_id),ADD FOREIGN KEY(tenant_id,authority_id) REFERENCES role_bindings(tenant_id,id),ADD FOREIGN KEY(tenant_id,nonce_session_id) REFERENCES sessions(tenant_id,id),ADD FOREIGN KEY(tenant_id,decided_session_id) REFERENCES sessions(tenant_id,id);
UPDATE approvals SET state='INVALIDATED',version=version+1 WHERE workflow_version=0 AND state IN ('PENDING','APPROVED');
CREATE UNIQUE INDEX approval_live_request ON approvals(tenant_id,action_id) WHERE state IN ('PENDING','APPROVED');
ALTER TABLE runs ADD COLUMN resume_action_id uuid,ADD COLUMN resume_kind text CHECK(resume_kind IN ('APPROVED_ACTION','RECONCILE','CONTEXT')),ADD COLUMN reset_context boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD FOREIGN KEY(tenant_id,resume_action_id,id,owner_id) REFERENCES tool_actions(tenant_id,id,run_id,owner_id);
CREATE TABLE control_events (
 tenant_id uuid NOT NULL,owner_id uuid NOT NULL,id uuid NOT NULL,seq bigserial NOT NULL,actor_id uuid NOT NULL,kind text NOT NULL,resource_id uuid NOT NULL,safe_data jsonb NOT NULL,previous_hash text,hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
GRANT SELECT,INSERT ON control_events TO oa_runtime;GRANT USAGE ON SEQUENCE control_events_seq_seq TO oa_runtime;GRANT SELECT ON control_events TO oa_app;
ALTER TABLE control_events ENABLE ROW LEVEL SECURITY;ALTER TABLE control_events FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON control_events USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND (owner_id=nullif(current_setting('app.actor_id',true),'')::uuid OR actor_id=nullif(current_setting('app.actor_id',true),'')::uuid)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE TABLE kill_switches (
 tenant_id uuid NOT NULL,id uuid NOT NULL,issuer_id uuid NOT NULL,scope_kind text NOT NULL CHECK(scope_kind IN ('TENANT','CONNECTOR','GROUP','USER','TASK')),scope_id text NOT NULL,mode text NOT NULL CHECK(mode IN ('ALL','WRITES')),enabled boolean NOT NULL,reason_hash text NOT NULL,expires_at timestamptz,version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,issuer_id,scope_kind,scope_id),FOREIGN KEY(tenant_id,issuer_id) REFERENCES users(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE ON kill_switches TO oa_runtime;GRANT SELECT ON kill_switches TO oa_app;
ALTER TABLE kill_switches ENABLE ROW LEVEL SECURITY;ALTER TABLE kill_switches FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON kill_switches USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE reconciliation_cases (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,action_id uuid NOT NULL,reviewer_id uuid NOT NULL,args_hash text NOT NULL,state text NOT NULL CHECK(state IN ('REQUESTED','VERIFYING','VERIFIED_APPLIED','VERIFIED_NOT_APPLIED','INCONCLUSIVE','MANUAL_APPLIED_UNVERIFIED')),claim text NOT NULL CHECK(claim IN ('APPLIED','NOT_APPLIED','INCONCLUSIVE')),evidence_ref jsonb NOT NULL,session_id uuid NOT NULL,authority_id uuid NOT NULL,authority_version bigint NOT NULL,reviewer_auth_epoch bigint NOT NULL,verification_method text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,action_id,owner_id) REFERENCES tool_actions(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,reviewer_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,session_id) REFERENCES sessions(tenant_id,id),FOREIGN KEY(tenant_id,authority_id) REFERENCES role_bindings(tenant_id,id),CHECK(owner_id<>reviewer_id)
);
GRANT SELECT,INSERT,UPDATE ON reconciliation_cases TO oa_runtime;
ALTER TABLE reconciliation_cases ENABLE ROW LEVEL SECURITY;ALTER TABLE reconciliation_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON reconciliation_cases USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND (owner_id=nullif(current_setting('app.actor_id',true),'')::uuid OR reviewer_id=nullif(current_setting('app.actor_id',true),'')::uuid)) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE FUNCTION public.oa_control_session(subject_arg uuid,session_arg uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN public.tenants t ON t.tenant_id=u.tenant_id WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND s.id=session_arg AND s.owner_id=subject_arg AND s.revoked_at IS NULL AND s.expires_at>now() AND s.auth_epoch=u.auth_epoch AND u.status='ACTIVE' AND t.status='ACTIVE');
$$;
CREATE FUNCTION public.oa_control_authority(subject_arg uuid,role_arg text,cap_arg text,resource_arg text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',b.id,'version',b.version,'authEpoch',u.auth_epoch,'expiresAt',b.expires_at) FROM public.role_bindings b JOIN public.roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_id JOIN public.tenants t ON t.tenant_id=b.tenant_id WHERE b.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND b.subject_id=subject_arg AND r.name=role_arg AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND u.status='ACTIVE' AND t.status='ACTIVE' AND (b.scope_kind='TENANT' AND b.scope_id=b.tenant_id::text OR b.scope_kind IN ('CAPABILITY','CONNECTOR') AND b.scope_id=cap_arg OR b.scope_kind IN ('RESOURCE','TASK','GROUP','USER') AND b.scope_id=resource_arg) ORDER BY (b.scope_kind='TENANT'),b.id LIMIT 1;
$$;
CREATE FUNCTION public.oa_control_action_view(action_arg uuid,session_arg uuid,subject_arg uuid DEFAULT nullif(current_setting('app.actor_id',true),'')::uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT to_jsonb(a)||jsonb_build_object('task_id',t.id,'task_status',t.status,'cancel_requested_at',t.cancel_requested_at,'task_auth_epoch',t.auth_epoch,'current_auth_epoch',u.auth_epoch,'user_status',u.status,'tenant_status',org.status,'policy_version',org.policy_version,'audience',t.audience,'expires_text',to_char(t.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'run_status',r.status)
 FROM public.tool_actions a JOIN public.runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id AND r.owner_id=a.owner_id JOIN public.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=a.owner_id JOIN public.users u ON u.tenant_id=a.tenant_id AND u.id=a.owner_id JOIN public.tenants org ON org.tenant_id=a.tenant_id
 WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.id=action_arg AND public.oa_control_session(subject_arg,session_arg)
 AND (a.owner_id=subject_arg OR EXISTS(SELECT 1 FROM public.approvals p WHERE p.tenant_id=a.tenant_id AND p.action_id=a.id AND p.approver_id=subject_arg AND p.workflow_version=1 AND public.oa_control_authority(p.approver_id,'ACTION_APPROVER',a.capability_id,a.resource_id) IS NOT NULL) OR a.state IN ('UNKNOWN','APPLIED_UNVERIFIED') AND a.owner_id<>subject_arg AND public.oa_control_authority(subject_arg,'SECURITY_OPERATOR',a.capability_id,a.resource_id) IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION public.oa_control_session(uuid,uuid),public.oa_control_authority(uuid,text,text,text),public.oa_control_action_view(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_control_session(uuid,uuid),public.oa_control_authority(uuid,text,text,text),public.oa_control_action_view(uuid,uuid,uuid) TO oa_runtime;
