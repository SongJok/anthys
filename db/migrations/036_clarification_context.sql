ALTER TABLE run_user_messages
 ADD COLUMN message_ref jsonb,
 ADD COLUMN message_seq bigint,
 ADD COLUMN generation bigint,
 ADD COLUMN expires_at timestamptz,
 ADD COLUMN content_state text NOT NULL DEFAULT 'LEGACY_UNAVAILABLE' CHECK(content_state IN ('LEGACY_UNAVAILABLE','SEALED'));
-- Old hash-only receipts are not fabricated into recovered user statements.
ALTER TABLE run_user_messages ADD CHECK(content_state='LEGACY_UNAVAILABLE' OR (message_ref IS NOT NULL AND message_seq>0 AND generation>0 AND expires_at IS NOT NULL) IS TRUE);
CREATE UNIQUE INDEX clarification_message_sequence ON run_user_messages(tenant_id,run_id,message_seq) WHERE message_seq IS NOT NULL;
