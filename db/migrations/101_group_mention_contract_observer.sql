-- Owner-scoped metadata only. Keep delegation rows and their live predicate
-- private; the runtime must not gain direct SELECT/EXECUTE on either.
CREATE FUNCTION public.oa_group_mention_contract(p_group text,p_scope uuid,p_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;c public.group_contracts;
BEGIN
 SELECT x.* INTO c FROM public.group_contracts x JOIN public.group_contract_delegations d ON d.tenant_id=x.tenant_id AND d.id=x.delegation_id
 JOIN public.dws_group_scopes s ON s.tenant_id=d.tenant_id AND s.id=d.scope_id AND s.owner_id=d.service_owner_id
 WHERE x.tenant_id=tenant AND x.group_id=p_group AND x.state='ACTIVE' AND x.valid_from<=clock_timestamp() AND x.expires_at>clock_timestamp()
 AND d.service_owner_id=actor AND d.scope_id=p_scope AND s.version=p_version AND s.conversation_external_id=p_group
 AND x.allowed_actions ? 'question.answer' AND NOT x.prohibited_actions ? 'question.answer' AND public.oa_group_delegation_live(d.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_MENTION_CURRENT_CONTRACT_REQUIRED';END IF;
 RETURN jsonb_build_object('id',c.id,'version',c.version,'document_hash',c.document_hash,'expires_at',c.expires_at,'delegation_id',c.delegation_id);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_mention_contract(text,uuid,bigint) FROM PUBLIC,oa_app,oa_queue;
GRANT EXECUTE ON FUNCTION public.oa_group_mention_contract(text,uuid,bigint) TO oa_runtime;
