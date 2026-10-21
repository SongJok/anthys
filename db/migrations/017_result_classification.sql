ALTER TABLE runs ADD COLUMN result_classification text CHECK(result_classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'));
-- Legacy results have no proven source classification. Keep them at the restrictive ceiling.
UPDATE runs SET result_classification='RESTRICTED' WHERE result IS NOT NULL;
UPDATE deliveries d SET classification='RESTRICTED' WHERE EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=d.tenant_id AND r.task_id=d.task_id AND r.result IS NOT NULL);
