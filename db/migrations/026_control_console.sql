CREATE FUNCTION public.oa_control_kill_authority(subject_arg uuid,kind_arg text,scope_arg text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',b.id,'version',b.version,'authEpoch',u.auth_epoch,'expiresAt',b.expires_at)
 FROM public.role_bindings b JOIN public.roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_id JOIN public.tenants t ON t.tenant_id=b.tenant_id
 WHERE b.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND b.subject_id=subject_arg AND r.name='SECURITY_OPERATOR' AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND u.status='ACTIVE' AND t.status='ACTIVE'
 AND (b.scope_kind='TENANT' AND b.scope_id=b.tenant_id::text OR b.scope_kind=kind_arg AND b.scope_id=scope_arg AND kind_arg IN ('CONNECTOR','GROUP','USER','TASK')) ORDER BY (b.scope_kind='TENANT'),b.id LIMIT 1;
$$;
CREATE FUNCTION public.oa_control_unknown_inbox(subject_arg uuid,session_arg uuid,cursor_arg uuid DEFAULT NULL) RETURNS TABLE(id uuid,capability_id text,risk text,state text,created_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT a.id,a.capability_id,a.risk,a.state,a.created_at FROM public.tool_actions a
 WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.owner_id<>subject_arg AND a.state='UNKNOWN' AND public.oa_control_session(subject_arg,session_arg)
 AND public.oa_control_authority_for(subject_arg,'SECURITY_OPERATOR',a.capability_id,a.resource_id,a.connector_id) IS NOT NULL
 AND (cursor_arg IS NULL OR (a.created_at,a.id)<(SELECT x.created_at,x.id FROM public.tool_actions x WHERE x.tenant_id=a.tenant_id AND x.id=cursor_arg AND x.owner_id<>subject_arg AND public.oa_control_authority_for(subject_arg,'SECURITY_OPERATOR',x.capability_id,x.resource_id,x.connector_id) IS NOT NULL))
 ORDER BY a.created_at DESC,a.id DESC LIMIT 51;
$$;
REVOKE ALL ON FUNCTION public.oa_control_kill_authority(uuid,text,text),public.oa_control_unknown_inbox(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_control_kill_authority(uuid,text,text),public.oa_control_unknown_inbox(uuid,uuid,uuid) TO oa_runtime;
CREATE INDEX tool_actions_unknown_console ON tool_actions(tenant_id,created_at DESC,id DESC) WHERE state='UNKNOWN';
