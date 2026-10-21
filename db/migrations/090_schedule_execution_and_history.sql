-- An exhausted rule can remain ACTIVE while its last occurrence is queued.
-- Finishing the local deterministic execution is separate from delivery evidence.
ALTER TABLE schedules DROP CONSTRAINT schedules_check;
CREATE TABLE schedule_events (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,schedule_id uuid NOT NULL,
 revision bigint NOT NULL,operation text NOT NULL,state text NOT NULL,
 payload_ref jsonb NOT NULL,payload_hash text NOT NULL,next_due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,schedule_id,owner_id) REFERENCES schedules(tenant_id,id,owner_id)
);
ALTER TABLE schedule_events ENABLE ROW LEVEL SECURITY;ALTER TABLE schedule_events FORCE ROW LEVEL SECURITY;
CREATE POLICY schedule_event_owner ON schedule_events USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON schedule_events TO oa_runtime;
CREATE TRIGGER schedule_event_immutable BEFORE UPDATE OR DELETE ON schedule_events FOR EACH ROW EXECUTE FUNCTION public.oa_group_contract_immutable();
