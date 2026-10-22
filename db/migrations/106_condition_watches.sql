-- Durable owner-scoped condition monitors. The policy is immutable for the
-- lifetime of a watch; every check, notification reservation and terminal
-- outcome is retained. Definitions only: no source, model or send authority
-- is granted by this migration.
CREATE TABLE public.condition_watches (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 policy_hash text NOT NULL CHECK(policy_hash~'^[a-f0-9]{64}$'),
 lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle IN ('ACTIVE','PAUSED','CANCELLED')),
 checks_started integer NOT NULL DEFAULT 0 CHECK(checks_started>=0),
 notifications_reserved integer NOT NULL DEFAULT 0 CHECK(notifications_reserved>=0),
 notification_state text NOT NULL DEFAULT 'IDLE' CHECK(notification_state IN ('IDLE','PENDING','UNKNOWN')),
 last_check_started_at timestamptz,last_notification_at timestamptz,
 last_notification_value_hash text CHECK(last_notification_value_hash IS NULL OR last_notification_value_hash~'^[a-f0-9]{64}$'),
 last_observation jsonb,last_value_hash text CHECK(last_value_hash IS NULL OR last_value_hash~'^[a-f0-9]{64}$'),
 stop_reason text CHECK(stop_reason IN ('EXPIRED','CHECK_LIMIT_REACHED','NOTIFICATION_LIMIT_REACHED')),
 next_check_at timestamptz,
 lease_owner text,lease_until timestamptz,
 lease_fence bigint NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
 max_checks integer NOT NULL CHECK(max_checks>0),
 max_notifications integer NOT NULL CHECK(max_notifications>0),
 interval_seconds integer NOT NULL CHECK(interval_seconds>=300),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK((checks_started>0)=(last_check_started_at IS NOT NULL)),
 CHECK((notifications_reserved>0)=(last_notification_at IS NOT NULL AND last_notification_value_hash IS NOT NULL)),
 CHECK(notifications_reserved<=checks_started),
 CHECK(lifecycle='CANCELLED' OR (stop_reason IS NULL OR next_check_at IS NULL)),
 CHECK(isfinite(expires_at))
);
CREATE INDEX condition_watches_due ON public.condition_watches(tenant_id,next_check_at,id) WHERE lifecycle='ACTIVE' AND notification_state='IDLE';
CREATE INDEX condition_watches_owner ON public.condition_watches(tenant_id,owner_id,created_at DESC,id);
ALTER TABLE public.condition_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.condition_watches FORCE ROW LEVEL SECURITY;
CREATE POLICY condition_watch_owner ON public.condition_watches USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON public.condition_watches TO oa_runtime;

CREATE TABLE public.condition_watch_checks (
 tenant_id uuid NOT NULL,id uuid NOT NULL,watch_id uuid NOT NULL,owner_id uuid NOT NULL,
 fence bigint NOT NULL CHECK(fence>0),
 state text NOT NULL CHECK(state IN ('CHECKING','COMPLETED','SUPPRESSED','FAILED')),
 outcome text,observation jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,watch_id,fence),
 FOREIGN KEY(tenant_id,watch_id) REFERENCES public.condition_watches(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK(state='CHECKING' OR completed_at IS NOT NULL)
);
CREATE INDEX condition_watch_checks_watch ON public.condition_watch_checks(tenant_id,watch_id,created_at DESC,id);
ALTER TABLE public.condition_watch_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.condition_watch_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY condition_watch_check_owner ON public.condition_watch_checks USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON public.condition_watch_checks TO oa_runtime;

CREATE TABLE public.condition_watch_notifications (
 tenant_id uuid NOT NULL,id uuid NOT NULL,watch_id uuid NOT NULL,owner_id uuid NOT NULL,check_id uuid NOT NULL,
 value_hash text NOT NULL CHECK(value_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CONFIRMED','FAILED','UNKNOWN')),
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),settled_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,check_id),
 FOREIGN KEY(tenant_id,watch_id) REFERENCES public.condition_watches(tenant_id,id),
 FOREIGN KEY(tenant_id,check_id) REFERENCES public.condition_watch_checks(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK(state='PENDING' OR settled_at IS NOT NULL)
);
CREATE INDEX condition_watch_notifications_pending ON public.condition_watch_notifications(tenant_id,watch_id,updated_at) WHERE state='PENDING';
ALTER TABLE public.condition_watch_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.condition_watch_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY condition_watch_notification_owner ON public.condition_watch_notifications USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON public.condition_watch_notifications TO oa_runtime;
