ALTER TABLE reconciliation_cases ADD COLUMN nonce_hash text,ADD COLUMN nonce_expires_at timestamptz,ADD COLUMN decided_at timestamptz;
REVOKE INSERT,UPDATE,DELETE ON approvals FROM oa_app;
