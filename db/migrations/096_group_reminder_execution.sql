-- Read only the cases registered for this exact reviewed scheduled origin.
-- No new authority or platform policy is installed by this migration.
CREATE FUNCTION public.oa_group_reminder_cases(p_occurrence uuid,p_fence bigint,p_phase text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;result jsonb;
BEGIN
 a:=public.oa_group_reminder_observer(p_occurrence,p_fence,p_phase);
 IF (SELECT count(*) FROM (SELECT 1 FROM public.group_cases c WHERE c.tenant_id=tenant AND c.group_id=a->>'groupId' AND c.contract_id=(a->>'contractId')::uuid LIMIT 10001) bounded)>10000 THEN RAISE EXCEPTION 'GROUP_REMINDER_CASE_LIMIT';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'version',c.version,'state',c.state,'ownerId',c.owner_id,'createdBy',c.created_by,'resourceHash',c.resource_hash,'payloadRef',c.payload_ref,'payloadHash',c.payload_hash,
 'sources',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'key',s.source_key,'eventId',s.source_event_id,'authorId',s.submitted_by,'createdAt',s.created_at,
 'authorActive',u.status='ACTIVE','externalId',u.external_user_id,'corpId',org.corp_id,'cipher',e.payload_cipher_ref,'eventState',e.state,'eventSource',e.source,'eventOwner',e.owner_id,
 'goal',(SELECT t.goal FROM public.tasks t JOIN public.conversations v ON v.tenant_id=t.tenant_id AND v.id=t.conversation_id AND v.kind='GROUP' AND v.external_id=c.group_id WHERE t.tenant_id=tenant AND t.source_event_id=s.source_event_id AND t.requester_id=s.submitted_by ORDER BY t.id LIMIT 1)) ORDER BY s.id),'[]'::jsonb)
 FROM public.group_case_sources s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.submitted_by JOIN public.tenants org ON org.tenant_id=s.tenant_id
 LEFT JOIN public.event_inbox e ON e.tenant_id=s.tenant_id AND e.id=s.source_event_id
 WHERE s.tenant_id=tenant AND s.case_id=c.id AND s.group_id=c.group_id)) ORDER BY c.id),'[]'::jsonb) INTO result
 FROM public.group_cases c WHERE c.tenant_id=tenant AND c.group_id=a->>'groupId' AND c.contract_id=(a->>'contractId')::uuid;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_cases(uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_cases(uuid,bigint,text) TO oa_runtime;

-- Recheck the same group-wide historical ledger before sending, excluding only
-- this origin's own immutable reservation. Old unresolved writes never expire
-- from the conservative quota, even after a service-owner/contract rotation.
CREATE FUNCTION public.oa_group_reminder_send_usage(p_occurrence uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;at_time timestamptz;result jsonb;
BEGIN
 a:=public.oa_group_reminder_observer(p_occurrence,p_fence,'SEND');
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-reminder-quota:'||(a->>'groupId'),0));at_time:=clock_timestamp();
 SELECT jsonb_build_object('tenantId',tenant,'groupId',a->>'groupId','from',at_time-interval '48 hours','until',at_time,'complete',true,'includesAllUnresolved',true,
 'notifications',coalesce(jsonb_agg(jsonb_build_object('notificationId',n.id,'at',greatest(n.reserved_at,d.sending_at),'caseIds',(SELECT jsonb_agg(nc.case_id ORDER BY nc.case_id) FROM public.group_reminder_notification_cases nc WHERE nc.tenant_id=tenant AND nc.notification_id=n.id),
 'state',CASE WHEN d.state IN ('PENDING','SENDING') THEN 'PENDING' WHEN d.state='SENT' THEN 'APPLIED_UNVERIFIED' ELSE d.state END) ORDER BY n.reserved_at,n.id),'[]'::jsonb)) INTO result
 FROM public.group_reminder_notifications n JOIN public.deliveries d ON d.tenant_id=n.tenant_id AND d.id=n.delivery_id
 WHERE n.tenant_id=tenant AND n.group_id=a->>'groupId' AND n.id<>(a->'occurrence'->>'notificationId')::uuid
 AND (greatest(n.reserved_at,d.sending_at)>=at_time-interval '48 hours' OR d.state IN ('PENDING','SENDING','UNKNOWN'));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_send_usage(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_send_usage(uuid,bigint) TO oa_runtime;

CREATE FUNCTION public.oa_group_reminder_runtime_open(p_schedule uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.group_reminder_schedules s JOIN public.group_reminder_authorizations g ON g.tenant_id=s.tenant_id AND g.id=s.authorization_id AND g.service_owner_id=s.owner_id
 WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND s.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND s.id=p_schedule AND s.state IN ('ACTIVE','COMPLETED')
 AND public.oa_group_reminder_authorization_live(g.id)
 AND NOT EXISTS(SELECT 1 FROM public.kill_switches k WHERE k.tenant_id=s.tenant_id AND k.enabled AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
 AND (k.scope_kind='TENANT' AND k.scope_id=s.tenant_id::text OR k.scope_kind='USER' AND k.scope_id IN (s.owner_id::text,g.administrator_id::text) OR k.scope_kind='GROUP' AND k.scope_id=s.group_id OR k.scope_kind='CONNECTOR' AND k.scope_id IN ('CORE','DWS','DINGTALK','DINGTALK_API','SCHEDULER'))));
$$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_runtime_open(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_runtime_open(uuid) TO oa_runtime;
