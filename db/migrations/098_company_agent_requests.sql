-- Local enterprise-agent request journal. No connector, grant, authorization,
-- budget or external sender is enabled by this migration.
ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK(status IN ('QUEUED','RUNNING','WAITING_EXTERNAL','WAITING_USER','WAITING_AUTH','WAITING_APPROVAL','RETRY_SCHEDULED','VERIFYING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','EXPIRED'));
CREATE TABLE company_agent_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,task_id uuid NOT NULL,run_id uuid NOT NULL,action_id uuid NOT NULL,
 action_key text NOT NULL,execution_attempt_id uuid NOT NULL,provider_session_no bigint NOT NULL CHECK(provider_session_no BETWEEN 1 AND 32),
 connector_id text NOT NULL CHECK(connector_id ~ '^[A-Za-z0-9._-]{1,128}$'),tool_name text NOT NULL CHECK(tool_name ~ '^[A-Za-z0-9_.-]{1,128}$'),
 upstream_hash text NOT NULL CHECK(upstream_hash ~ '^[a-f0-9]{64}$'),
 connection_hash text NOT NULL CHECK(connection_hash ~ '^[a-f0-9]{64}$'),input_schema_hash text NOT NULL CHECK(input_schema_hash ~ '^[a-f0-9]{64}$'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),budget_hash text NOT NULL CHECK(budget_hash ~ '^[a-f0-9]{64}$'),
 message_hash text NOT NULL CHECK(message_hash ~ '^[a-f0-9]{64}$'),message_bytes int NOT NULL CHECK(message_bytes BETWEEN 1 AND 65536),
 auth_epoch bigint NOT NULL,policy_version text NOT NULL,audience jsonb NOT NULL,group_audience_id uuid,persona_snapshot_id uuid,
 wait_budget_ms int NOT NULL CHECK(wait_budget_ms BETWEEN 1 AND 1200000),deadline timestamptz NOT NULL,budget_expires_at timestamptz NOT NULL,
 max_dispatched int NOT NULL CHECK(max_dispatched BETWEEN 1 AND 1000),max_unresolved int NOT NULL CHECK(max_unresolved BETWEEN 1 AND 8),
 state text NOT NULL CHECK(state IN ('QUEUED','DISPATCHING','RESPONSE_RECEIVED','NOT_SENT','UNKNOWN','CANCELLED','BLOCKED','EXPIRED')),
 dispatch_started_at timestamptz,local_cancellation_requested_at timestamptz,
 remote_cancellation text NOT NULL DEFAULT 'NOT_REQUESTED' CHECK(remote_cancellation IN ('NOT_REQUESTED','UNCONFIRMED')),
 enterprise_cost text NOT NULL DEFAULT 'NOT_DISPATCHED' CHECK(enterprise_cost IN ('NOT_DISPATCHED','UNKNOWN')),
 response_ref jsonb,response_hash text CHECK(response_hash ~ '^[a-f0-9]{64}$'),reason_code text CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
 worker_id text,lease_until timestamptz,fence bigint NOT NULL DEFAULT 0,resumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,action_key),UNIQUE(tenant_id,action_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id),FOREIGN KEY(tenant_id,action_id) REFERENCES tool_actions(tenant_id,id),
 CHECK((dispatch_started_at IS NULL)=(enterprise_cost='NOT_DISPATCHED')),
 CHECK(state<>'RESPONSE_RECEIVED' OR (dispatch_started_at IS NOT NULL AND response_ref IS NOT NULL AND response_hash IS NOT NULL)),
 CHECK(state<>'DISPATCHING' OR dispatch_started_at IS NOT NULL),
 CHECK(state<>'UNKNOWN' OR dispatch_started_at IS NOT NULL),
 CHECK(state NOT IN ('NOT_SENT','CANCELLED','BLOCKED','EXPIRED') OR dispatch_started_at IS NULL),
 CHECK(deadline<=budget_expires_at),CHECK(deadline<=created_at+wait_budget_ms*interval '1 millisecond')
);
CREATE INDEX company_agent_requests_task ON company_agent_requests(tenant_id,owner_id,task_id,created_at,id);
CREATE INDEX company_agent_requests_claim ON company_agent_requests(tenant_id,owner_id,state,lease_until,created_at,id) WHERE state IN ('QUEUED','DISPATCHING');
CREATE INDEX company_agent_requests_budget ON company_agent_requests(tenant_id,budget_hash,dispatch_started_at);
ALTER TABLE company_agent_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE company_agent_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON company_agent_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON company_agent_requests TO oa_runtime;

-- Boolean only: another employee's payload, identity, scope and balances are
-- never returned. The connector-wide lock serializes all owners, including
-- unresolved historical attempts after their authorization window expired.
CREATE FUNCTION public.oa_company_agent_budget_available(request_arg uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;actor uuid=nullif(current_setting('app.actor_id',true),'')::uuid;q public.company_agent_requests;used bigint;unresolved bigint;ceiling int;
BEGIN
 SELECT * INTO q FROM public.company_agent_requests WHERE tenant_id=tenant AND owner_id=actor AND id=request_arg;
 IF NOT FOUND OR q.state<>'QUEUED' OR q.dispatch_started_at IS NOT NULL OR q.deadline<=clock_timestamp() OR q.budget_expires_at<=clock_timestamp() THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':company-agent:budget:'||q.budget_hash,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':company-agent:'||q.upstream_hash,0));
 IF q.deadline<=clock_timestamp() OR q.budget_expires_at<=clock_timestamp() THEN RETURN false;END IF;
 SELECT count(*) INTO used FROM public.company_agent_requests p WHERE p.tenant_id=tenant AND p.budget_hash=q.budget_hash AND p.dispatch_started_at IS NOT NULL;
 SELECT count(*),least(q.max_unresolved,coalesce(min(p.max_unresolved),q.max_unresolved)) INTO unresolved,ceiling FROM public.company_agent_requests p WHERE p.tenant_id=tenant AND p.upstream_hash=q.upstream_hash AND p.state IN ('DISPATCHING','UNKNOWN');
 RETURN used<q.max_dispatched AND unresolved<ceiling;
END $$;
REVOKE ALL ON FUNCTION public.oa_company_agent_budget_available(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_company_agent_budget_available(uuid) TO oa_runtime;

-- Existing privacy producers cancel the affected runs. Erase this new retained
-- body in the same transaction, preserving only the uncertain dispatch ledger.
CREATE FUNCTION public.oa_company_agent_run_stopped() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.status IN ('CANCELLED','EXPIRED') OR NEW.provider_session_no<>OLD.provider_session_no THEN
  UPDATE public.company_agent_requests SET state=CASE WHEN dispatch_started_at IS NULL THEN 'CANCELLED' ELSE 'UNKNOWN' END,
   response_ref=NULL,response_hash=NULL,local_cancellation_requested_at=coalesce(local_cancellation_requested_at,clock_timestamp()),
   remote_cancellation=CASE WHEN dispatch_started_at IS NULL THEN 'NOT_REQUESTED' ELSE 'UNCONFIRMED' END,
   reason_code=CASE WHEN NEW.provider_session_no<>OLD.provider_session_no THEN 'PROVIDER_SESSION_CHANGED' ELSE 'RUN_STOPPED' END,
   worker_id=NULL,lease_until=NULL,fence=fence+1,updated_at=clock_timestamp()
  WHERE tenant_id=NEW.tenant_id AND run_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.oa_company_agent_run_stopped() FROM PUBLIC;
CREATE TRIGGER company_agent_run_stopped AFTER UPDATE OF status,provider_session_no ON runs FOR EACH ROW EXECUTE FUNCTION public.oa_company_agent_run_stopped();

-- Stop mutations and a new enterprise dispatch have an explicit ordering.
-- Applies to operator SQL as well as ControlPlane, without granting any new
-- ability to mutate a stop switch. A committed ALL stop is observed before an
-- attempt can be committed; a stop after the marker retains UNKNOWN instead.
CREATE FUNCTION public.oa_company_agent_kill_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN RAISE EXCEPTION 'KILL_TENANT_IMMUTABLE';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END)::text||':company-agent:kill',0));
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.oa_company_agent_kill_barrier() FROM PUBLIC;
CREATE TRIGGER company_agent_kill_barrier BEFORE INSERT OR UPDATE OR DELETE ON kill_switches FOR EACH ROW EXECUTE FUNCTION public.oa_company_agent_kill_barrier();
