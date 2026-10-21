ALTER TABLE deliveries DROP CONSTRAINT deliveries_state_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_state_check CHECK(state IN ('PENDING','SENDING','SENT','APPLIED_UNVERIFIED','FAILED','UNKNOWN','SUPPRESSED'));
ALTER TABLE deliveries ADD COLUMN attempt_key uuid;
ALTER TABLE deliveries ADD COLUMN sending_at timestamptz;
ALTER TABLE deliveries ADD COLUMN classification text NOT NULL DEFAULT 'INTERNAL' CHECK(classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'));
ALTER TABLE deliveries ADD COLUMN verification_state text NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_state IN ('VERIFIED','UNVERIFIED','MISMATCH'));
ALTER TABLE deliveries ADD COLUMN verification_method text;
CREATE INDEX deliveries_due ON deliveries(tenant_id,owner_id,next_at,id) WHERE state='PENDING';
ALTER TABLE conversations ADD COLUMN members_complete boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN source_mode text NOT NULL DEFAULT 'MENTION_ONLY' CHECK(source_mode IN ('MENTION_ONLY','AUTHORIZED_HISTORY','AUTHORIZED_EVENTS'));
CREATE FUNCTION public.oa_join_verified_conversation(external_id_arg text,kind_arg text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tid uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;
 aid uuid=nullif(current_setting('app.actor_id',true),'')::uuid;
 cid uuid;
BEGIN
 IF tid IS NULL OR aid IS NULL OR kind_arg NOT IN ('DM','GROUP') OR length(external_id_arg) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION 'INVALID_VERIFIED_CONTEXT' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=tid AND u.id=aid AND u.status='ACTIVE' AND t.status='ACTIVE') THEN RAISE EXCEPTION 'IDENTITY_INACTIVE' USING ERRCODE='42501'; END IF;
 INSERT INTO public.conversations(tenant_id,id,channel,external_id,kind) VALUES(tid,gen_random_uuid(),'DINGTALK',external_id_arg,kind_arg) ON CONFLICT(tenant_id,channel,external_id) DO NOTHING;
 SELECT c.id INTO cid FROM public.conversations c WHERE c.tenant_id=tid AND c.channel='DINGTALK' AND c.external_id=external_id_arg AND c.kind=kind_arg FOR UPDATE;
 IF cid IS NULL THEN RAISE EXCEPTION 'CONVERSATION_KIND_MISMATCH' USING ERRCODE='42501'; END IF;
 IF kind_arg='DM' AND EXISTS(SELECT 1 FROM public.conversation_members m WHERE m.tenant_id=tid AND m.conversation_id=cid AND m.user_id<>aid AND m.valid_to IS NULL) THEN RAISE EXCEPTION 'DM_IDENTITY_MISMATCH' USING ERRCODE='42501'; END IF;
 INSERT INTO public.conversation_members(tenant_id,id,conversation_id,user_id) VALUES(tid,gen_random_uuid(),cid,aid) ON CONFLICT(tenant_id,conversation_id,user_id) WHERE valid_to IS NULL DO NOTHING;
 RETURN cid;
END; $$;
REVOKE ALL ON FUNCTION public.oa_join_verified_conversation(text,text) FROM PUBLIC;
-- Only trusted ingress/runtime uses this narrowly scoped bridge after SDK verification.
GRANT EXECUTE ON FUNCTION public.oa_join_verified_conversation(text,text) TO oa_runtime;
