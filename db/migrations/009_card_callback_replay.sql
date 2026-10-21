-- Existing receipts cannot prove an original payload hash. Reject their reuse conservatively.
ALTER TABLE card_callback_receipts ADD COLUMN request_hash text NOT NULL DEFAULT 'LEGACY_UNVERIFIED';
ALTER TABLE card_callback_receipts ALTER COLUMN request_hash DROP DEFAULT;
