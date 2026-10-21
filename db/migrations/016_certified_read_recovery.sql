ALTER TABLE tool_actions ADD COLUMN retry_safety text NOT NULL DEFAULT 'UNKNOWN' CHECK(retry_safety IN ('UNKNOWN','CERTIFIED_READ'));
