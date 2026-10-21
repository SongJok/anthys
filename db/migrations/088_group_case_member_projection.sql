-- Do not broaden owner-private DWS scope/directory SELECT policies for group
-- administrators. Expose only this group's current reviewed roster projection.
CREATE FUNCTION public.oa_group_case_members(p_group text,p_session uuid) RETURNS TABLE(id uuid,name text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;
BEGIN
 a:=public.oa_group_case_authority(p_group,p_session,'case.read',NULL);
 RETURN QUERY SELECT b.user_id,u.display_name FROM public.group_directory_bindings b
 JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.user_id
 WHERE b.tenant_id=tenant AND b.scope_id=(a->>'scopeId')::uuid AND b.revoked_at IS NULL
 AND b.expires_at>clock_timestamp() AND u.status='ACTIVE' AND b.user_auth_epoch=u.auth_epoch
 AND b.external_user_id=u.external_user_id AND b.open_dingtalk_id=u.open_dingtalk_id
 ORDER BY b.user_id LIMIT 2000;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_case_members(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_case_members(text,uuid) TO oa_runtime;
