-- A late callback may record only its own execution attempt, even after lease loss.
ALTER TABLE tool_actions ADD COLUMN execution_attempt_id uuid;
