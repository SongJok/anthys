-- Durable sandbox broker admission and lifecycle. The broker owns nonce replay
-- prevention, one-shot state transitions, cancellation and per-owner quota
-- counters. Result bytes are never stored here; only bounded metadata and the
-- sink reference are retained.
CREATE TABLE public.sandbox_broker_jobs (
 tenant_id uuid NOT NULL,
 job_id uuid NOT NULL,
 task_id uuid NOT NULL,
 run_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 auth_epoch integer NOT NULL CHECK(auth_epoch>0),
 nonce uuid NOT NULL,
 image_digest text NOT NULL CHECK(image_digest~'^sha256:[a-f0-9]{64}$'),
 job_hash text NOT NULL CHECK(job_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'RESERVED' CHECK(state IN ('RESERVED','RUNNING','SUCCEEDED','FAILED','TIMEOUT','CANCELLED','LIMIT_EXCEEDED','REJECTED')),
 failure_code text CHECK(failure_code IS NULL OR failure_code~'^[A-Z0-9_]{1,64}$'),
 cancel_requested_at timestamptz,
 started_at timestamptz,
 completed_at timestamptz,
 result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object'),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,job_id),
 UNIQUE(tenant_id,nonce),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES public.users(tenant_id,id),
 CHECK(isfinite(expires_at)),
 CHECK(state IN ('RESERVED','RUNNING') OR completed_at IS NOT NULL),
 CHECK(state<>'RUNNING' OR (started_at IS NOT NULL AND completed_at IS NULL)),
 CHECK(started_at IS NULL OR state<>'RESERVED'),
 CHECK(failure_code IS NULL OR state NOT IN ('RESERVED','RUNNING','SUCCEEDED')),
 CHECK(result IS NULL OR state NOT IN ('RESERVED','RUNNING'))
);
CREATE INDEX sandbox_broker_jobs_active ON public.sandbox_broker_jobs(tenant_id,actor_id,created_at,job_id) WHERE state IN ('RESERVED','RUNNING');
CREATE INDEX sandbox_broker_jobs_recent ON public.sandbox_broker_jobs(tenant_id,actor_id,created_at DESC,job_id);
ALTER TABLE public.sandbox_broker_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sandbox_broker_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_broker_job_owner ON public.sandbox_broker_jobs USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON public.sandbox_broker_jobs TO oa_runtime;
