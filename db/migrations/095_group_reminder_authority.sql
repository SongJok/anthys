-- Installed scheduled-contract authority is separate from H5/native origins.
-- No grant, schedule, credential, external send or service is activated here.
ALTER TABLE tasks DROP CONSTRAINT tasks_control_kind_check;
ALTER TABLE tasks ADD CHECK(control_kind IN ('STOP','CLARIFICATION_REPLY','PERSONA','MEMORY','REMINDER','SCHEDULE','GROUP_CASE','GROUP_REMINDER'));
CREATE TABLE public.group_reminder_authorizations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,group_id text NOT NULL,contract_id uuid NOT NULL,contract_version bigint NOT NULL,contract_hash text NOT NULL,
 delegation_id uuid NOT NULL,administrator_id uuid NOT NULL,service_owner_id uuid NOT NULL,service_identity_id uuid NOT NULL,scope_id uuid NOT NULL,
 owner_auth_epoch bigint NOT NULL,service_authorization_version bigint NOT NULL,scope_version bigint NOT NULL,
 valid_from timestamptz NOT NULL,expires_at timestamptz NOT NULL,reminders_per_case_day integer NOT NULL CHECK(reminders_per_case_day BETWEEN 0 AND 2),summaries_per_group_hour integer NOT NULL CHECK(summaries_per_group_hour BETWEEN 0 AND 6),
 document jsonb NOT NULL,document_hash text NOT NULL CHECK(document_hash~'^[a-f0-9]{64}$'),review_reference text NOT NULL,operator_role text NOT NULL,
 revoked_at timestamptz,revoke_reference text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,service_owner_id),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES public.group_contracts(tenant_id,id),FOREIGN KEY(tenant_id,delegation_id) REFERENCES public.group_contract_delegations(tenant_id,id),
 FOREIGN KEY(tenant_id,administrator_id) REFERENCES public.users(tenant_id,id),FOREIGN KEY(tenant_id,service_identity_id,service_owner_id) REFERENCES public.dws_identities(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,scope_id,service_owner_id) REFERENCES public.dws_group_scopes(tenant_id,id,owner_id),
 CHECK(expires_at>valid_from AND contract_version>0 AND owner_auth_epoch>0 AND service_authorization_version>0 AND scope_version>0 AND contract_hash~'^[a-f0-9]{64}$'),CHECK((revoked_at IS NULL)=(revoke_reference IS NULL))
);
CREATE TRIGGER group_reminder_authorization_immutable BEFORE UPDATE OR DELETE ON public.group_reminder_authorizations FOR EACH ROW EXECUTE FUNCTION public.oa_group_delegation_immutable();
CREATE TABLE public.group_reminder_schedules (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,group_id text NOT NULL,contract_id uuid NOT NULL,authorization_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),state text NOT NULL CHECK(state IN ('ACTIVE','PAUSED','CANCELLED','COMPLETED','BLOCKED')),
 definition_ref jsonb NOT NULL,definition_hash text NOT NULL CHECK(definition_hash~'^[a-f0-9]{64}$'),next_due_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,authorization_id,owner_id) REFERENCES public.group_reminder_authorizations(tenant_id,id,service_owner_id),FOREIGN KEY(tenant_id,contract_id) REFERENCES public.group_contracts(tenant_id,id)
);
CREATE INDEX group_reminder_due ON public.group_reminder_schedules(tenant_id,owner_id,next_due_at,id) WHERE state='ACTIVE';
CREATE TABLE public.group_reminder_occurrences (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,schedule_id uuid NOT NULL,revision bigint NOT NULL,generation bigint NOT NULL,
 scheduled_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,state text NOT NULL CHECK(state IN ('QUEUED','STAGED','SKIPPED','MISSED','REVOKED')),fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
 notification_id uuid NOT NULL,task_id uuid,run_id uuid,delivery_id uuid,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,schedule_id,revision,generation,scheduled_at),UNIQUE(tenant_id,notification_id),UNIQUE(tenant_id,run_id),
 FOREIGN KEY(tenant_id,schedule_id,owner_id) REFERENCES public.group_reminder_schedules(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,task_id) REFERENCES public.tasks(tenant_id,id),FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES public.runs(tenant_id,id,owner_id),FOREIGN KEY(tenant_id,delivery_id) REFERENCES public.deliveries(tenant_id,id),
 CHECK((task_id IS NULL)=(run_id IS NULL)),CHECK(state<>'STAGED' OR task_id IS NOT NULL AND delivery_id IS NOT NULL AND fence>0)
);
CREATE INDEX group_reminder_pending ON public.group_reminder_occurrences(tenant_id,owner_id,created_at,id) WHERE state='QUEUED';
CREATE TABLE public.group_reminder_notifications (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,group_id text NOT NULL,occurrence_id uuid NOT NULL,delivery_id uuid NOT NULL,
 reserved_at timestamptz NOT NULL,contract_id uuid NOT NULL,contract_version bigint NOT NULL,contract_hash text NOT NULL,
 origin_hash text NOT NULL,content_hash text NOT NULL,proof_ref jsonb NOT NULL,proof_hash text NOT NULL,item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 20),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,occurrence_id),UNIQUE(tenant_id,delivery_id),
 FOREIGN KEY(tenant_id,occurrence_id) REFERENCES public.group_reminder_occurrences(tenant_id,id),FOREIGN KEY(tenant_id,delivery_id) REFERENCES public.deliveries(tenant_id,id),FOREIGN KEY(tenant_id,contract_id) REFERENCES public.group_contracts(tenant_id,id),
 CHECK(contract_hash~'^[a-f0-9]{64}$' AND origin_hash~'^[a-f0-9]{64}$' AND content_hash~'^[a-f0-9]{64}$' AND proof_hash~'^[a-f0-9]{64}$')
);
CREATE INDEX group_reminder_usage ON public.group_reminder_notifications(tenant_id,group_id,reserved_at,id);
CREATE TABLE public.group_reminder_notification_cases (
 tenant_id uuid NOT NULL,notification_id uuid NOT NULL,owner_id uuid NOT NULL,case_id uuid NOT NULL,case_version bigint NOT NULL,resource_hash text NOT NULL,
 PRIMARY KEY(tenant_id,notification_id,case_id),FOREIGN KEY(tenant_id,notification_id) REFERENCES public.group_reminder_notifications(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES public.group_cases(tenant_id,id),CHECK(case_version>0 AND resource_hash~'^[a-f0-9]{64}$')
);
CREATE TABLE public.group_reminder_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,schedule_id uuid NOT NULL,intent_hash text NOT NULL,
 revision bigint NOT NULL,state text NOT NULL,operation text NOT NULL CHECK(operation IN ('CREATE','EDIT','PAUSE','RESUME','CANCEL')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id,actor_id),FOREIGN KEY(tenant_id,schedule_id) REFERENCES public.group_reminder_schedules(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES public.users(tenant_id,id)
);
CREATE TRIGGER group_reminder_request_immutable BEFORE UPDATE OR DELETE ON public.group_reminder_requests FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
CREATE TRIGGER group_reminder_notification_immutable BEFORE UPDATE OR DELETE ON public.group_reminder_notifications FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
CREATE TRIGGER group_reminder_notification_case_immutable BEFORE UPDATE OR DELETE ON public.group_reminder_notification_cases FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
ALTER TABLE public.group_reminder_authorizations ENABLE ROW LEVEL SECURITY;ALTER TABLE public.group_reminder_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_reminder_schedules ENABLE ROW LEVEL SECURITY;ALTER TABLE public.group_reminder_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_reminder_occurrences ENABLE ROW LEVEL SECURITY;ALTER TABLE public.group_reminder_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_reminder_notifications ENABLE ROW LEVEL SECURITY;ALTER TABLE public.group_reminder_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_reminder_notification_cases ENABLE ROW LEVEL SECURITY;ALTER TABLE public.group_reminder_notification_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_reminder_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE public.group_reminder_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY group_reminder_authorization_owner ON public.group_reminder_authorizations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND service_owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY group_reminder_schedule_owner ON public.group_reminder_schedules USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY group_reminder_occurrence_owner ON public.group_reminder_occurrences USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY group_reminder_notification_owner ON public.group_reminder_notifications USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY group_reminder_notification_case_owner ON public.group_reminder_notification_cases USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY group_reminder_request_actor ON public.group_reminder_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON public.group_reminder_authorizations TO oa_runtime;
GRANT SELECT,INSERT,UPDATE ON public.group_reminder_schedules,public.group_reminder_occurrences TO oa_runtime;
GRANT SELECT,INSERT ON public.group_reminder_notifications,public.group_reminder_notification_cases TO oa_runtime;

-- Only an explicitly approved installation can grant proactive group delivery.
CREATE FUNCTION public.oa_group_reminder_authorize(p_document text,p_hash text,p_review text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE j jsonb;tenant uuid;c public.group_contracts;d public.group_contract_delegations;g public.group_reminder_authorizations;
BEGIN
 IF current_user<>'oa_migrator' THEN RAISE EXCEPTION 'GROUP_REMINDER_MIGRATOR_REQUIRED';END IF;
 IF p_document IS NULL OR octet_length(p_document)>65536 OR p_hash IS DISTINCT FROM encode(sha256(convert_to(p_document,'UTF8')),'hex') OR p_review IS NULL OR length(p_review) NOT BETWEEN 8 AND 512 THEN RAISE EXCEPTION 'GROUP_REMINDER_AUTHORIZATION_INVALID';END IF;
 j:=p_document::jsonb;
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR j->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR j->'approved' IS DISTINCT FROM 'true'::jsonb OR j->>'purpose' IS DISTINCT FROM 'SCHEDULED_CONTRACT'
 OR (SELECT count(*) FROM jsonb_object_keys(j))<>24 OR NOT j ?& ARRAY['schemaVersion','approved','purpose','id','tenantId','groupId','contractId','contractVersion','contractHash','delegationId','serviceOwnerId','serviceIdentityId','scopeId','ownerAuthEpoch','serviceAuthorizationVersion','scopeVersion','validFrom','expiresAt','limits','reviewReference','sourceReviewHash','allowMentionAll','allowDirectMessages','allowEscalation']
 OR j->>'sourceReviewHash' !~ '^[a-f0-9]{64}$' OR p_review !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$'
 OR jsonb_typeof(j->'limits') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(j->'limits'))<>2 OR NOT (j->'limits') ?& ARRAY['remindersPerCasePerDay','summariesPerGroupPerHour']
 OR j->>'reviewReference' IS DISTINCT FROM p_review OR j->'allowMentionAll' IS DISTINCT FROM 'false'::jsonb OR j->'allowDirectMessages' IS DISTINCT FROM 'false'::jsonb OR j->'allowEscalation' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'GROUP_REMINDER_AUTHORIZATION_INVALID';END IF;
 tenant:=(j->>'tenantId')::uuid;PERFORM set_config('app.tenant_id',tenant::text,true);
 IF NOT public.oa_schedule_lifecycle_open() OR NOT isfinite((j->>'validFrom')::timestamptz) OR NOT isfinite((j->>'expiresAt')::timestamptz) THEN RAISE EXCEPTION 'GROUP_REMINDER_LIFECYCLE_BLOCKED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||(j->>'groupId'),0));
 SELECT * INTO c FROM public.group_contracts WHERE tenant_id=tenant AND id=(j->>'contractId')::uuid AND group_id=j->>'groupId';
 SELECT * INTO d FROM public.group_contract_delegations WHERE tenant_id=tenant AND id=c.delegation_id;
 IF c.id IS NULL OR c.state<>'ACTIVE' OR c.valid_from>clock_timestamp() OR c.expires_at<=clock_timestamp() OR c.version IS DISTINCT FROM (j->>'contractVersion')::bigint OR c.document_hash IS DISTINCT FROM j->>'contractHash'
 OR NOT c.allowed_actions ? 'case.remind' OR c.prohibited_actions ? 'case.remind' OR NOT public.oa_group_delegation_live(d.id)
 OR d.id IS DISTINCT FROM (j->>'delegationId')::uuid OR d.service_owner_id IS DISTINCT FROM (j->>'serviceOwnerId')::uuid OR d.service_identity_id IS DISTINCT FROM (j->>'serviceIdentityId')::uuid OR d.scope_id IS DISTINCT FROM (j->>'scopeId')::uuid
 OR d.service_owner_epoch IS DISTINCT FROM (j->>'ownerAuthEpoch')::bigint OR d.service_authorization_version IS DISTINCT FROM (j->>'serviceAuthorizationVersion')::bigint OR d.scope_version IS DISTINCT FROM (j->>'scopeVersion')::bigint
 OR (j->>'expiresAt')::timestamptz>d.valid_until
 OR NOT EXISTS(SELECT 1 FROM public.dws_identities i JOIN public.dws_group_scopes s ON s.tenant_id=i.tenant_id AND s.id=d.scope_id AND s.owner_id=i.owner_id WHERE i.tenant_id=tenant AND i.id=d.service_identity_id AND i.model_egress_allowed AND i.delegation_expires_at>=(j->>'expiresAt')::timestamptz AND s.expires_at>=(j->>'expiresAt')::timestamptz)
 OR (j->>'expiresAt')::timestamptz>c.expires_at OR (j->>'expiresAt')::timestamptz<=clock_timestamp() OR (j->>'validFrom')::timestamptz>=(j->>'expiresAt')::timestamptz
 THEN RAISE EXCEPTION 'GROUP_REMINDER_AUTHORIZATION_SOURCE_INVALID';END IF;
 SELECT * INTO g FROM public.group_reminder_authorizations WHERE tenant_id=tenant AND id=(j->>'id')::uuid;
 IF FOUND THEN IF g.document_hash IS DISTINCT FROM p_hash OR g.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'GROUP_REMINDER_AUTHORIZATION_CONFLICT';END IF;RETURN g.id;END IF;
 INSERT INTO public.group_reminder_authorizations(tenant_id,id,group_id,contract_id,contract_version,contract_hash,delegation_id,administrator_id,service_owner_id,service_identity_id,scope_id,owner_auth_epoch,service_authorization_version,scope_version,valid_from,expires_at,reminders_per_case_day,summaries_per_group_hour,document,document_hash,review_reference,operator_role)
 VALUES(tenant,(j->>'id')::uuid,c.group_id,c.id,c.version,c.document_hash,d.id,d.administrator_id,d.service_owner_id,d.service_identity_id,d.scope_id,d.service_owner_epoch,d.service_authorization_version,d.scope_version,(j->>'validFrom')::timestamptz,(j->>'expiresAt')::timestamptz,(j->'limits'->>'remindersPerCasePerDay')::integer,(j->'limits'->>'summariesPerGroupPerHour')::integer,j,p_hash,p_review,current_user);RETURN (j->>'id')::uuid;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_authorize(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_authorize(text,text,text) TO oa_migrator;
CREATE FUNCTION public.oa_group_reminder_authorization_revoke(p_id uuid,p_hash text,p_review text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_user<>'oa_migrator' OR p_review IS NULL OR length(p_review) NOT BETWEEN 8 AND 512 THEN RAISE EXCEPTION 'GROUP_REMINDER_REVIEW_REQUIRED';END IF;
 UPDATE public.group_reminder_authorizations SET revoked_at=clock_timestamp(),revoke_reference=p_review WHERE id=p_id AND document_hash=p_hash AND revoked_at IS NULL;
 IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM public.group_reminder_authorizations WHERE id=p_id AND document_hash=p_hash AND revoked_at IS NOT NULL) THEN RAISE EXCEPTION 'GROUP_REMINDER_AUTHORIZATION_CONFLICT';END IF;RETURN p_id;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_authorization_revoke(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_authorization_revoke(uuid,text,text) TO oa_migrator;

CREATE FUNCTION public.oa_group_reminder_authorization_live(p_id uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.oa_schedule_lifecycle_open() AND EXISTS(SELECT 1 FROM public.group_reminder_authorizations g
 JOIN public.group_contracts c ON c.tenant_id=g.tenant_id AND c.id=g.contract_id AND c.group_id=g.group_id
 JOIN public.group_contract_delegations d ON d.tenant_id=g.tenant_id AND d.id=g.delegation_id AND c.delegation_id=d.id
 JOIN public.dws_identities i ON i.tenant_id=g.tenant_id AND i.id=g.service_identity_id AND i.owner_id=g.service_owner_id
 JOIN public.dws_group_scopes s ON s.tenant_id=g.tenant_id AND s.id=g.scope_id AND s.owner_id=g.service_owner_id
 WHERE g.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND g.id=p_id AND g.revoked_at IS NULL
 AND g.valid_from<=clock_timestamp() AND g.expires_at>clock_timestamp() AND c.state='ACTIVE'
 AND c.valid_from<=clock_timestamp() AND c.expires_at>clock_timestamp() AND c.version=g.contract_version AND c.document_hash=g.contract_hash
 AND c.allowed_actions ?& ARRAY['case.read','case.remind'] AND NOT c.prohibited_actions ?| ARRAY['case.read','case.remind']
 AND public.oa_group_delegation_live(d.id) AND d.administrator_id=g.administrator_id AND d.service_owner_id=g.service_owner_id
 AND d.service_identity_id=g.service_identity_id AND d.scope_id=g.scope_id AND d.service_owner_epoch=g.owner_auth_epoch
 AND d.service_authorization_version=g.service_authorization_version AND d.scope_version=g.scope_version
 AND i.model_egress_allowed AND i.auth_epoch=g.owner_auth_epoch AND i.authorization_version=g.service_authorization_version
 AND s.version=g.scope_version AND g.expires_at<=least(c.expires_at,d.valid_until,i.delegation_expires_at,s.expires_at)
 AND EXISTS(SELECT 1 FROM public.resource_grants r WHERE r.tenant_id=g.tenant_id AND r.actor_id=g.service_owner_id
  AND r.capability_id='dws.group.audience' AND r.resource_id='dingtalk:group:'||g.group_id
  AND r.audience_kind='PRIVATE_USER' AND r.audience_id=g.service_owner_id::text
  AND r.classification_ceiling IN ('INTERNAL','CONFIDENTIAL','RESTRICTED') AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()));
$$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_authorization_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_authorization_live(uuid) TO oa_runtime;

-- This authority has no H5 session and no invented native event/task. Every
-- dynamic reference is resolved from the persisted occurrence under its source lock.
CREATE FUNCTION public.oa_group_reminder_observer(p_occurrence uuid,p_fence bigint,p_phase text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;o public.group_reminder_occurrences;s public.group_reminder_schedules;g public.group_reminder_authorizations;result jsonb;group_key text;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('PLAN','SEND') OR p_fence IS NULL OR p_fence<=0 THEN RAISE EXCEPTION 'GROUP_REMINDER_ORIGIN_INVALID';END IF;
 SELECT sc.group_id INTO group_key FROM public.group_reminder_occurrences oc JOIN public.group_reminder_schedules sc ON sc.tenant_id=oc.tenant_id AND sc.id=oc.schedule_id AND sc.owner_id=oc.owner_id
 WHERE oc.tenant_id=tenant AND oc.id=p_occurrence AND oc.owner_id=actor;
 IF group_key IS NULL THEN RAISE EXCEPTION 'GROUP_REMINDER_ORIGIN_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-contract:'||group_key,0));
 SELECT * INTO o FROM public.group_reminder_occurrences WHERE tenant_id=tenant AND id=p_occurrence AND owner_id=actor;
 SELECT * INTO s FROM public.group_reminder_schedules WHERE tenant_id=tenant AND id=o.schedule_id AND owner_id=actor;
 SELECT * INTO g FROM public.group_reminder_authorizations WHERE tenant_id=tenant AND id=s.authorization_id AND service_owner_id=actor;
 IF o.id IS NULL OR s.id IS NULL OR g.id IS NULL OR s.group_id IS DISTINCT FROM g.group_id OR s.contract_id IS DISTINCT FROM g.contract_id
 OR s.revision IS DISTINCT FROM o.revision OR s.generation IS DISTINCT FROM o.generation OR o.fence IS DISTINCT FROM p_fence
 OR s.state NOT IN ('ACTIVE','COMPLETED') OR o.expires_at<=clock_timestamp() OR o.scheduled_at>clock_timestamp()
 OR NOT public.oa_group_reminder_authorization_live(g.id)
 OR p_phase='PLAN' AND (o.state<>'QUEUED' OR o.task_id IS NOT NULL OR o.delivery_id IS NOT NULL)
 OR p_phase='SEND' AND (o.state<>'STAGED' OR o.task_id IS NULL OR o.run_id IS NULL OR o.delivery_id IS NULL)
 THEN RAISE EXCEPTION 'GROUP_REMINDER_ORIGIN_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM public.kill_switches k WHERE k.tenant_id=tenant AND k.enabled AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
 AND (k.scope_kind='TENANT' AND k.scope_id=tenant::text OR k.scope_kind='USER' AND k.scope_id IN (actor::text,g.administrator_id::text) OR k.scope_kind='GROUP' AND k.scope_id=g.group_id OR k.scope_kind='CONNECTOR' AND k.scope_id IN ('CORE','DWS','DINGTALK','DINGTALK_API','SCHEDULER')))
 THEN RAISE EXCEPTION 'GROUP_REMINDER_STOPPED';END IF;
 SELECT jsonb_build_object('groupId',g.group_id,'contractId',c.id,'contractVersion',c.version,'contractHash',c.document_hash,'revisionId',c.current_revision_id,
 'delegationId',d.id,'delegationHash',d.document_hash,'administratorId',d.administrator_id,'serviceOwnerId',d.service_owner_id,'identityId',d.service_identity_id,
 'ownerAuthEpoch',u.auth_epoch,'authorizationVersion',i.authorization_version,'subject',jsonb_build_object('corpId',i.corp_id,'userId',i.external_user_id),
 'policyVersion',t.policy_version,'scopeId',sc.id,'scopeVersion',sc.version,'scopeExpiresAt',sc.expires_at,'contractExpiresAt',c.expires_at,
 'profile',sc.info_profile,'approvedBots',sc.approved_bots,'binaryHash',sc.binary_hash,'membersSchemaHash',sc.members_schema_hash,'infoSchemaHash',sc.info_schema_hash,'contractSchemaHash',sc.contract_hash,
 'scopeReview',sc.authorization_review_ref,'directoryReview',sc.directory_review_ref,
 'grantBindings',(SELECT jsonb_agg(jsonb_build_object('id',r.id,'expiresAt',r.expires_at,'classification',r.classification_ceiling) ORDER BY r.id) FROM public.resource_grants r WHERE r.tenant_id=tenant AND r.actor_id=actor AND r.capability_id='dws.group.audience' AND r.resource_id='dingtalk:group:'||g.group_id AND r.audience_kind='PRIVATE_USER' AND r.audience_id=actor::text AND r.classification_ceiling IN ('INTERNAL','CONFIDENTIAL','RESTRICTED') AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()),
 'authorization',jsonb_build_object('id',g.id,'version',1,'documentHash',g.document_hash,'expiresAt',g.expires_at,'limits',jsonb_build_object('remindersPerCasePerDay',g.reminders_per_case_day,'summariesPerGroupPerHour',g.summaries_per_group_hour)),
 'schedule',jsonb_build_object('id',s.id,'revision',s.revision,'generation',s.generation,'definitionHash',s.definition_hash),
 'occurrence',jsonb_build_object('id',o.id,'fence',o.fence,'scheduledAt',o.scheduled_at,'expiresAt',o.expires_at,'notificationId',o.notification_id,'phase',p_phase),
 'originHash',encode(sha256(convert_to(jsonb_build_array(tenant,actor,g.group_id,s.id,s.revision,s.generation,s.definition_hash,o.id,o.fence,o.scheduled_at,o.notification_id,g.id,g.document_hash,c.id,c.version,c.document_hash)::text,'UTF8')),'hex'))
 INTO result FROM public.group_contracts c JOIN public.group_contract_delegations d ON d.tenant_id=c.tenant_id AND d.id=c.delegation_id
 JOIN public.users u ON u.tenant_id=d.tenant_id AND u.id=d.service_owner_id JOIN public.tenants t ON t.tenant_id=c.tenant_id
 JOIN public.dws_identities i ON i.tenant_id=d.tenant_id AND i.id=d.service_identity_id AND i.owner_id=d.service_owner_id
 JOIN public.dws_group_scopes sc ON sc.tenant_id=d.tenant_id AND sc.id=d.scope_id AND sc.owner_id=d.service_owner_id
 WHERE c.tenant_id=tenant AND c.id=g.contract_id AND c.group_id=g.group_id;
 IF result IS NULL THEN RAISE EXCEPTION 'GROUP_REMINDER_ORIGIN_INVALID';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_observer(uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_observer(uuid,bigint,text) TO oa_runtime;

CREATE FUNCTION public.oa_group_reminder_observed_members(p_occurrence uuid,p_fence bigint,p_phase text,p_open_ids text[]) RETURNS TABLE(id uuid,name text,open_id text,binding jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;
BEGIN
 a:=public.oa_group_reminder_observer(p_occurrence,p_fence,p_phase);
 IF p_open_ids IS NULL OR cardinality(p_open_ids) NOT BETWEEN 1 AND 2000 OR cardinality(p_open_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_open_ids) x)
 OR EXISTS(SELECT 1 FROM unnest(p_open_ids) x WHERE x IS NULL OR length(x) NOT BETWEEN 1 AND 256 OR (SELECT count(*) FROM public.users u WHERE u.tenant_id=tenant AND u.open_dingtalk_id=x AND u.status='ACTIVE')<>1)
 THEN RAISE EXCEPTION 'GROUP_REMINDER_ROSTER_UNVERIFIED';END IF;
 RETURN QUERY SELECT b.user_id,u.display_name,b.open_dingtalk_id,jsonb_build_array(b.id,b.version,b.user_id,b.open_dingtalk_id,b.external_user_id,b.user_auth_epoch,b.directory_authority_ref,b.expires_at,u.auth_epoch)
 FROM public.group_directory_bindings b JOIN public.users u ON u.tenant_id=b.tenant_id AND u.id=b.user_id
 WHERE b.tenant_id=tenant AND b.scope_id=(a->>'scopeId')::uuid AND b.open_dingtalk_id=ANY(p_open_ids) AND b.revoked_at IS NULL AND b.expires_at>clock_timestamp() AND u.status='ACTIVE'
 AND b.user_auth_epoch=u.auth_epoch AND b.external_user_id=u.external_user_id AND b.open_dingtalk_id=u.open_dingtalk_id ORDER BY b.open_dingtalk_id,b.id;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_observed_members(uuid,bigint,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_observed_members(uuid,bigint,text,text[]) TO oa_runtime;

-- Include all service owners and all old UNKNOWN/SENDING/PENDING records in the
-- same tenant/group. A contract or service-owner rotation cannot reset quotas.
CREATE FUNCTION public.oa_group_reminder_usage(p_occurrence uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;group_key text;at_time timestamptz;result jsonb;
BEGIN
 a:=public.oa_group_reminder_observer(p_occurrence,p_fence,'PLAN');
 SELECT s.group_id INTO group_key FROM public.group_reminder_schedules s WHERE s.tenant_id=tenant AND s.id=(a->'schedule'->>'id')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-reminder-quota:'||group_key,0));
 at_time:=clock_timestamp();
 SELECT jsonb_build_object('tenantId',tenant,'groupId',group_key,'from',at_time-interval '48 hours','until',at_time,'complete',true,'includesAllUnresolved',true,
 'notifications',coalesce(jsonb_agg(jsonb_build_object('notificationId',n.id,'at',greatest(n.reserved_at,d.sending_at),'caseIds',(SELECT jsonb_agg(nc.case_id ORDER BY nc.case_id) FROM public.group_reminder_notification_cases nc WHERE nc.tenant_id=tenant AND nc.notification_id=n.id),
 'state',CASE WHEN d.state IN ('PENDING','SENDING') THEN 'PENDING' WHEN d.state='SENT' THEN 'APPLIED_UNVERIFIED' ELSE d.state END) ORDER BY n.reserved_at,n.id),'[]'::jsonb)) INTO result
 FROM public.group_reminder_notifications n JOIN public.deliveries d ON d.tenant_id=n.tenant_id AND d.id=n.delivery_id
 WHERE n.tenant_id=tenant AND n.group_id=group_key AND (greatest(n.reserved_at,d.sending_at)>=at_time-interval '48 hours' OR d.state IN ('PENDING','SENDING','UNKNOWN'));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_usage(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_usage(uuid,bigint) TO oa_runtime;

CREATE FUNCTION public.oa_group_reminder_admin_authority(p_group text,p_session uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a jsonb;
BEGIN
 a:=public.oa_group_case_authority(p_group,p_session,'case.read',NULL);
 IF a->'administrator' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'GROUP_REMINDER_ADMIN_REQUIRED';END IF;RETURN a;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_admin_authority(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_admin_authority(text,uuid) TO oa_runtime;

CREATE FUNCTION public.oa_group_reminder_admin_list(p_group text,p_session uuid,p_cursor uuid,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;result jsonb;
BEGIN
 a:=public.oa_group_reminder_admin_authority(p_group,p_session);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'GROUP_REMINDER_INPUT_INVALID';END IF;
 SELECT jsonb_build_object('schedules',coalesce((SELECT jsonb_agg(row_to_json(q)) FROM (SELECT s.*,public.oa_group_reminder_authorization_live(s.authorization_id) authority_live,g.contract_version,g.expires_at authorization_expires_at,g.reminders_per_case_day,g.summaries_per_group_hour
 FROM public.group_reminder_schedules s JOIN public.group_reminder_authorizations g ON g.tenant_id=s.tenant_id AND g.id=s.authorization_id
 WHERE s.tenant_id=tenant AND s.group_id=p_group AND (p_cursor IS NULL OR s.id>p_cursor) ORDER BY s.id LIMIT p_limit+1) q),'[]'::jsonb),
 'authorizations',coalesce((SELECT jsonb_agg(row_to_json(q)) FROM (SELECT g.id,g.contract_version,g.expires_at,g.reminders_per_case_day,g.summaries_per_group_hour FROM public.group_reminder_authorizations g WHERE g.tenant_id=tenant AND g.group_id=p_group AND public.oa_group_reminder_authorization_live(g.id) ORDER BY g.expires_at,g.id LIMIT 50) q),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_admin_list(text,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_admin_list(text,uuid,uuid,integer) TO oa_runtime;

CREATE FUNCTION public.oa_group_reminder_admin_occurrence(p_group text,p_session uuid,p_schedule uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;result jsonb;
BEGIN
 a:=public.oa_group_reminder_admin_authority(p_group,p_session);
 SELECT jsonb_build_object('id',o.id,'scheduledAt',o.scheduled_at,'deliveryState',CASE WHEN d.state='SENT' THEN 'APPLIED_UNVERIFIED' ELSE coalesce(d.state,o.state) END,'verification','UNVERIFIED','itemCount',coalesce(n.item_count,0)) INTO result
 FROM public.group_reminder_occurrences o JOIN public.group_reminder_schedules s ON s.tenant_id=o.tenant_id AND s.id=o.schedule_id
 LEFT JOIN public.deliveries d ON d.tenant_id=o.tenant_id AND d.id=o.delivery_id LEFT JOIN public.group_reminder_notifications n ON n.tenant_id=o.tenant_id AND n.occurrence_id=o.id
 WHERE o.tenant_id=tenant AND o.schedule_id=p_schedule AND s.group_id=p_group ORDER BY o.scheduled_at DESC,o.id DESC LIMIT 1;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_admin_occurrence(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_admin_occurrence(text,uuid,uuid) TO oa_runtime;

-- Ciphertext is sealed by the server after strict schedule-rule parsing. This
-- function alone crosses administrator B to the reviewed service owner A rows.
CREATE FUNCTION public.oa_group_reminder_admin_write(p_group text,p_session uuid,p_operation text,p_id uuid,p_expected bigint,p_authorization uuid,p_contract_version bigint,p_request uuid,p_intent text,p_cipher jsonb,p_definition_hash text,p_next timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;a jsonb;s public.group_reminder_schedules;g public.group_reminder_authorizations;r public.group_reminder_requests;service_owner uuid;
BEGIN
 a:=public.oa_group_reminder_admin_authority(p_group,p_session);
 IF p_operation IS NULL OR p_operation NOT IN ('CREATE','EDIT','PAUSE','RESUME','CANCEL') OR p_id IS NULL OR p_request IS NULL OR p_expected IS NULL OR p_expected<0 OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'GROUP_REMINDER_INPUT_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':group-reminder-request:'||actor::text||':'||p_request::text,0));
 SELECT * INTO r FROM public.group_reminder_requests WHERE tenant_id=tenant AND id=p_request AND actor_id=actor;
 IF FOUND THEN
  SELECT * INTO s FROM public.group_reminder_schedules WHERE tenant_id=tenant AND id=r.schedule_id AND group_id=p_group;
  IF s.id IS NULL OR r.intent_hash IS DISTINCT FROM p_intent THEN RAISE EXCEPTION 'GROUP_REMINDER_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('id',s.id,'replayed',true);
 END IF;
 SELECT installed.service_owner_id INTO service_owner FROM public.group_reminder_authorizations installed WHERE installed.tenant_id=tenant AND installed.group_id=p_group AND installed.id=CASE WHEN p_operation='CREATE' THEN p_authorization ELSE (SELECT sc.authorization_id FROM public.group_reminder_schedules sc WHERE sc.tenant_id=tenant AND sc.group_id=p_group AND sc.id=p_id) END;
 IF p_operation IN ('CREATE','EDIT','RESUME') AND EXISTS(SELECT 1 FROM public.kill_switches k WHERE k.tenant_id=tenant AND k.enabled AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND (k.scope_kind='TENANT' AND k.scope_id=tenant::text OR k.scope_kind='USER' AND k.scope_id IN (actor::text,service_owner::text) OR k.scope_kind='GROUP' AND k.scope_id=p_group OR k.scope_kind='CONNECTOR' AND k.scope_id IN ('CORE','DWS','DINGTALK','DINGTALK_API','SCHEDULER'))) THEN RAISE EXCEPTION 'GROUP_REMINDER_STOPPED';END IF;
 IF p_operation='CREATE' THEN
  IF (SELECT count(*) FROM public.group_reminder_schedules WHERE tenant_id=tenant AND group_id=p_group AND state IN ('ACTIVE','PAUSED','BLOCKED'))>=100 THEN RAISE EXCEPTION 'GROUP_REMINDER_GROUP_LIMIT';END IF;
  SELECT * INTO g FROM public.group_reminder_authorizations WHERE tenant_id=tenant AND id=p_authorization AND group_id=p_group AND administrator_id=actor;
  IF g.id IS NULL OR p_expected<>0 OR g.contract_id IS DISTINCT FROM (a->>'contractId')::uuid OR g.contract_version IS DISTINCT FROM p_contract_version OR NOT public.oa_group_reminder_authorization_live(g.id)
  THEN RAISE EXCEPTION 'GROUP_REMINDER_AUTHORIZATION_REQUIRED';END IF;
  IF p_cipher IS NULL OR jsonb_typeof(p_cipher)<>'object' OR p_definition_hash IS NULL OR p_definition_hash !~ '^[a-f0-9]{64}$' OR p_next IS NULL OR NOT isfinite(p_next) OR p_next<=clock_timestamp() OR p_next>=g.expires_at THEN RAISE EXCEPTION 'GROUP_REMINDER_RULE_OUTSIDE_AUTHORIZATION';END IF;
  INSERT INTO public.group_reminder_schedules(tenant_id,id,owner_id,group_id,contract_id,authorization_id,state,definition_ref,definition_hash,next_due_at) VALUES(tenant,p_id,g.service_owner_id,p_group,g.contract_id,g.id,'ACTIVE',p_cipher,p_definition_hash,p_next) RETURNING * INTO s;
 ELSE
  SELECT * INTO s FROM public.group_reminder_schedules WHERE tenant_id=tenant AND id=p_id AND group_id=p_group FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'GROUP_REMINDER_NOT_FOUND';END IF;
  IF s.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'GROUP_REMINDER_REVISION_CONFLICT';END IF;
  IF s.state='CANCELLED' OR p_operation='PAUSE' AND s.state<>'ACTIVE' OR p_operation='RESUME' AND s.state<>'PAUSED' OR p_operation='EDIT' AND s.state NOT IN ('ACTIVE','PAUSED') THEN RAISE EXCEPTION 'GROUP_REMINDER_TRANSITION_DENIED';END IF;
  SELECT * INTO g FROM public.group_reminder_authorizations WHERE tenant_id=tenant AND id=s.authorization_id;
  IF p_operation IN ('EDIT','RESUME') AND (g.administrator_id IS DISTINCT FROM actor OR NOT public.oa_group_reminder_authorization_live(g.id)) THEN RAISE EXCEPTION 'GROUP_REMINDER_AUTHORIZATION_REQUIRED';END IF;
  IF p_operation IN ('EDIT','RESUME') AND (p_next IS NULL OR NOT isfinite(p_next) OR p_next<=clock_timestamp() OR p_next>=g.expires_at) THEN RAISE EXCEPTION 'GROUP_REMINDER_RULE_OUTSIDE_AUTHORIZATION';END IF;
  IF p_operation='EDIT' AND (p_cipher IS NULL OR jsonb_typeof(p_cipher)<>'object' OR p_definition_hash IS NULL OR p_definition_hash !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'GROUP_REMINDER_INPUT_INVALID';END IF;
  -- Revision/generation invalidation is atomic with suppression. An already
  -- dispatched SENDING/UNKNOWN record is retained and never claimed recalled.
  UPDATE public.deliveries de SET state='SUPPRESSED',last_error='GROUP_REMINDER_SOURCE_CHANGED',version=version+1,updated_at=clock_timestamp()
  FROM public.group_reminder_occurrences o WHERE o.tenant_id=tenant AND o.schedule_id=s.id AND de.tenant_id=tenant AND de.id=o.delivery_id AND de.state='PENDING';
  UPDATE public.group_reminder_occurrences SET state='REVOKED',last_error='GROUP_REMINDER_SOURCE_CHANGED',updated_at=clock_timestamp() WHERE tenant_id=tenant AND schedule_id=s.id AND state='QUEUED';
  UPDATE public.group_reminder_schedules SET revision=revision+1,generation=generation+1,
  state=CASE p_operation WHEN 'PAUSE' THEN 'PAUSED' WHEN 'CANCEL' THEN 'CANCELLED' WHEN 'RESUME' THEN 'ACTIVE' ELSE state END,
  definition_ref=CASE WHEN p_operation='EDIT' THEN p_cipher ELSE definition_ref END,definition_hash=CASE WHEN p_operation='EDIT' THEN p_definition_hash ELSE definition_hash END,
  next_due_at=CASE WHEN p_operation IN ('PAUSE','CANCEL') OR p_operation='EDIT' AND s.state='PAUSED' THEN NULL ELSE p_next END,last_error=NULL,updated_at=clock_timestamp()
  WHERE tenant_id=tenant AND id=s.id RETURNING * INTO s;
 END IF;
 INSERT INTO public.group_reminder_requests(tenant_id,id,actor_id,schedule_id,intent_hash,revision,state,operation) VALUES(tenant,p_request,actor,s.id,p_intent,s.revision,s.state,p_operation);
 RETURN jsonb_build_object('id',s.id,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_admin_write(text,uuid,text,uuid,bigint,uuid,bigint,uuid,text,jsonb,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_admin_write(text,uuid,text,uuid,bigint,uuid,bigint,uuid,text,jsonb,text,timestamptz) TO oa_runtime;

CREATE FUNCTION public.oa_group_reminder_admin_get(p_group text,p_session uuid,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;result jsonb;
BEGIN
 a:=public.oa_group_reminder_admin_authority(p_group,p_session);
 SELECT to_jsonb(s)||jsonb_build_object('authority_live',public.oa_group_reminder_authorization_live(g.id),'contract_version',g.contract_version,'authorization_expires_at',g.expires_at,'reminders_per_case_day',g.reminders_per_case_day,'summaries_per_group_hour',g.summaries_per_group_hour) INTO result
 FROM public.group_reminder_schedules s JOIN public.group_reminder_authorizations g ON g.tenant_id=s.tenant_id AND g.id=s.authorization_id WHERE s.tenant_id=tenant AND s.group_id=p_group AND s.id=p_id;
 IF result IS NULL THEN RAISE EXCEPTION 'GROUP_REMINDER_NOT_FOUND';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_admin_get(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_admin_get(text,uuid,uuid) TO oa_runtime;

CREATE FUNCTION public.oa_group_reminder_admin_service_owner(p_group text,p_session uuid,p_authorization uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;a jsonb;result uuid;
BEGIN
 a:=public.oa_group_reminder_admin_authority(p_group,p_session);
 SELECT service_owner_id INTO result FROM public.group_reminder_authorizations WHERE tenant_id=tenant AND id=p_authorization AND group_id=p_group AND public.oa_group_reminder_authorization_live(id);
 IF result IS NULL THEN RAISE EXCEPTION 'GROUP_REMINDER_AUTHORIZATION_REQUIRED';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_admin_service_owner(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_admin_service_owner(text,uuid,uuid) TO oa_runtime;

-- Replays still require the actual current administrator and group/session
-- authority. Resolve persisted intent before recomputing an elapsed ONCE rule.
CREATE FUNCTION public.oa_group_reminder_admin_replay(p_group text,p_session uuid,p_request uuid,p_intent text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;r public.group_reminder_requests;
BEGIN
 PERFORM public.oa_group_reminder_admin_authority(p_group,p_session);
 SELECT * INTO r FROM public.group_reminder_requests WHERE tenant_id=tenant AND actor_id=actor AND id=p_request;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.intent_hash IS DISTINCT FROM p_intent OR NOT EXISTS(SELECT 1 FROM public.group_reminder_schedules WHERE tenant_id=tenant AND id=r.schedule_id AND group_id=p_group) THEN RAISE EXCEPTION 'GROUP_REMINDER_REQUEST_CONFLICT';END IF;
 RETURN jsonb_build_object('id',r.schedule_id,'replayed',true);
END $$;
REVOKE ALL ON FUNCTION public.oa_group_reminder_admin_replay(text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_group_reminder_admin_replay(text,uuid,uuid,text) TO oa_runtime;
