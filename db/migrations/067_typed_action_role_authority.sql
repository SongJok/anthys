-- Resolve typed scopes from the persisted action, never from a resource ID
-- reused as a task, user or group identifier.
CREATE FUNCTION public.oa_control_action_authority(subject_arg uuid,role_arg text,action_arg uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',b.id,'version',b.version,'authEpoch',u.auth_epoch,'expiresAt',b.expires_at)
 FROM public.tool_actions a
 JOIN public.runs run ON run.tenant_id=a.tenant_id AND run.id=a.run_id AND run.owner_id=a.owner_id
 JOIN public.tasks task ON task.tenant_id=a.tenant_id AND task.id=run.task_id AND task.requester_id=a.owner_id
 JOIN public.role_bindings b ON b.tenant_id=a.tenant_id AND b.subject_id=subject_arg
 JOIN public.roles role ON role.tenant_id=b.tenant_id AND role.id=b.role_id
 JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_id
 JOIN public.tenants org ON org.tenant_id=b.tenant_id
 WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.id=action_arg
 AND role.name=role_arg AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()) AND u.status='ACTIVE' AND org.status='ACTIVE'
 AND (b.scope_kind='TENANT' AND b.scope_id=b.tenant_id::text
   OR b.scope_kind='CAPABILITY' AND b.scope_id=a.capability_id
   OR b.scope_kind='CONNECTOR' AND b.scope_id=a.connector_id
   OR b.scope_kind='RESOURCE' AND b.scope_id=a.resource_id
   OR b.scope_kind='TASK' AND b.scope_id=task.id::text
   OR b.scope_kind='USER' AND b.scope_id=a.owner_id::text
   OR b.scope_kind='GROUP'
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(a.execution_audience,a.scope_descriptor->'operationAudience')) audiences(value) WHERE audiences.value->>'kind'='GROUP' AND audiences.value->>'targetId'=b.scope_id)
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(a.execution_audience,a.scope_descriptor->'operationAudience')) audiences(value) WHERE audiences.value->>'kind'='GROUP' AND (audiences.value->>'targetId') IS DISTINCT FROM b.scope_id))
 ORDER BY (b.scope_kind='TENANT'),b.id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.oa_control_action_authority(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_control_action_authority(uuid,text,uuid) TO oa_runtime;

-- Legacy callers lack a typed task/owner/audience context. Do not guess it.
CREATE OR REPLACE FUNCTION public.oa_control_authority_for(subject_arg uuid,role_arg text,cap_arg text,resource_arg text,connector_arg text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',b.id,'version',b.version,'authEpoch',u.auth_epoch,'expiresAt',b.expires_at)
 FROM public.role_bindings b JOIN public.roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_id JOIN public.tenants t ON t.tenant_id=b.tenant_id
 WHERE b.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND b.subject_id=subject_arg AND r.name=role_arg AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()) AND u.status='ACTIVE' AND t.status='ACTIVE'
 AND (b.scope_kind='TENANT' AND b.scope_id=b.tenant_id::text OR b.scope_kind='CAPABILITY' AND b.scope_id=cap_arg OR b.scope_kind='CONNECTOR' AND b.scope_id=connector_arg OR b.scope_kind='RESOURCE' AND b.scope_id=resource_arg)
 ORDER BY (b.scope_kind='TENANT'),b.id LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.oa_control_authority(subject_arg uuid,role_arg text,cap_arg text,resource_arg text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT public.oa_control_authority_for(subject_arg,role_arg,cap_arg,resource_arg,NULL); $$;

-- AFTER INSERT deliberately excludes INSERT ... ON CONFLICT DO NOTHING.
-- A successful grant must fence old role snapshots and execution leases.
CREATE FUNCTION public.oa_role_binding_grant_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE public.users SET auth_epoch=auth_epoch+1,version=version+1 WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id;
 RETURN NEW;
END;$$;
CREATE TRIGGER role_binding_grant_epoch AFTER INSERT ON role_bindings FOR EACH ROW EXECUTE FUNCTION public.oa_role_binding_grant_epoch();
REVOKE ALL ON FUNCTION public.oa_role_binding_grant_epoch() FROM PUBLIC;

-- Moving a binding also invalidates the new recipient, while retaining the
-- existing old-recipient invalidation and binding-version increment.
CREATE OR REPLACE FUNCTION public.oa_role_binding_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE public.users SET auth_epoch=auth_epoch+1,version=version+1 WHERE tenant_id=OLD.tenant_id AND id=OLD.subject_id;
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.subject_id) IS DISTINCT FROM (OLD.tenant_id,OLD.subject_id) THEN
   UPDATE public.users SET auth_epoch=auth_epoch+1,version=version+1 WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id;
  END IF;
  NEW.version=OLD.version+1;RETURN NEW;
 END IF;
 RETURN OLD;
END;$$;

CREATE OR REPLACE FUNCTION public.oa_control_action_view(action_arg uuid,session_arg uuid,subject_arg uuid DEFAULT nullif(current_setting('app.actor_id',true),'')::uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT to_jsonb(a)||jsonb_build_object('task_id',t.id,'task_status',t.status,'cancel_requested_at',t.cancel_requested_at,'task_auth_epoch',t.auth_epoch,'current_auth_epoch',u.auth_epoch,'user_status',u.status,'tenant_status',org.status,'policy_version',org.policy_version,'audience',t.audience,'expires_text',to_char(t.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'run_status',r.status)
 FROM public.tool_actions a JOIN public.runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id AND r.owner_id=a.owner_id JOIN public.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=a.owner_id JOIN public.users u ON u.tenant_id=a.tenant_id AND u.id=a.owner_id JOIN public.tenants org ON org.tenant_id=a.tenant_id
 WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.id=action_arg AND public.oa_control_session(subject_arg,session_arg)
 AND (a.owner_id=subject_arg OR EXISTS(SELECT 1 FROM public.approvals p WHERE p.tenant_id=a.tenant_id AND p.action_id=a.id AND p.approver_id=subject_arg AND p.workflow_version=1 AND public.oa_control_action_authority(p.approver_id,'ACTION_APPROVER',a.id) IS NOT NULL) OR a.state IN ('UNKNOWN','APPLIED_UNVERIFIED') AND a.owner_id<>subject_arg AND public.oa_control_action_authority(subject_arg,'SECURITY_OPERATOR',a.id) IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION public.oa_control_unknown_inbox(subject_arg uuid,session_arg uuid,cursor_arg uuid DEFAULT NULL) RETURNS TABLE(id uuid,capability_id text,risk text,state text,created_at timestamptz) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT a.id,a.capability_id,a.risk,a.state,a.created_at FROM public.tool_actions a
 WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.owner_id<>subject_arg AND a.state='UNKNOWN' AND public.oa_control_session(subject_arg,session_arg)
 AND public.oa_control_action_authority(subject_arg,'SECURITY_OPERATOR',a.id) IS NOT NULL
 AND (cursor_arg IS NULL OR (a.created_at,a.id)<(SELECT x.created_at,x.id FROM public.tool_actions x WHERE x.tenant_id=a.tenant_id AND x.id=cursor_arg AND x.owner_id<>subject_arg AND public.oa_control_action_authority(subject_arg,'SECURITY_OPERATOR',x.id) IS NOT NULL))
 ORDER BY a.created_at DESC,a.id DESC LIMIT 51;
$$;
