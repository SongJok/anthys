ALTER TABLE clarification_control_responses ADD COLUMN origin_task_id uuid;
ALTER TABLE clarification_control_responses ADD FOREIGN KEY(tenant_id,origin_task_id) REFERENCES tasks(tenant_id,id);
