ALTER TABLE card_instances DROP CONSTRAINT card_instances_state_check;
UPDATE card_instances SET state='FINALIZED_UNVERIFIED' WHERE state='FINALIZED';
ALTER TABLE card_instances ADD CONSTRAINT card_instances_state_check CHECK(state IN ('NEW','CREATING','ACTIVE','FINALIZED_UNVERIFIED','FAILED','UNKNOWN','SUPPRESSED'));
