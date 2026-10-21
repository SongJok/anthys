ALTER TABLE tasks ADD COLUMN control_kind text CHECK(control_kind IN ('STOP'));
CREATE INDEX tasks_conversation_controls ON tasks(tenant_id,requester_id,conversation_id,created_at,id) WHERE control_kind IS NULL;
