ALTER TABLE tasks ADD CONSTRAINT tasks_owner_reference UNIQUE(tenant_id,id,requester_id);
ALTER TABLE event_inbox ADD CONSTRAINT event_inbox_owner_reference UNIQUE(tenant_id,id,owner_id);
ALTER TABLE attachments ADD CONSTRAINT attachments_owner_reference UNIQUE(tenant_id,id,owner_id);
ALTER TABLE attachments ADD CONSTRAINT attachments_owned_task_fk FOREIGN KEY(tenant_id,task_id,owner_id) REFERENCES tasks(tenant_id,id,requester_id);
ALTER TABLE attachments ADD CONSTRAINT attachments_owned_event_fk FOREIGN KEY(tenant_id,source_event_id,owner_id) REFERENCES event_inbox(tenant_id,id,owner_id);
ALTER TABLE task_attachment_dependencies ADD CONSTRAINT attachment_dependencies_owned_source_fk FOREIGN KEY(tenant_id,attachment_id,owner_id) REFERENCES attachments(tenant_id,id,owner_id);
ALTER TABLE task_attachment_dependencies ADD CONSTRAINT attachment_dependencies_owned_task_fk FOREIGN KEY(tenant_id,task_id,owner_id) REFERENCES tasks(tenant_id,id,requester_id);
