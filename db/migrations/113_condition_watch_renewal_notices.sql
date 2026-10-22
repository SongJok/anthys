-- Advance renewal notices for condition watches. A watch stores one immutable
-- policy and expiry; it never renews itself. At most one notice row exists per
-- watch, and only the delivery state changes. Definitions only: no send
-- authority is granted by this migration.
CREATE TABLE public.condition_watch_renewal_notices (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 watch_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 policy_hash text NOT NULL CHECK(policy_hash~'^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CONFIRMED','APPLIED_UNVERIFIED','FAILED','UNKNOWN')),
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 3),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,watch_id),
 FOREIGN KEY(tenant_id,watch_id) REFERENCES public.condition_watches(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK(state='PENDING' OR settled_at IS NOT NULL),
 CHECK(isfinite(expires_at))
);
CREATE INDEX condition_watch_renewals_pending ON public.condition_watch_renewal_notices(tenant_id,owner_id,updated_at) WHERE state='PENDING';
ALTER TABLE public.condition_watch_renewal_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.condition_watch_renewal_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY condition_watch_renewal_owner ON public.condition_watch_renewal_notices USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON public.condition_watch_renewal_notices TO oa_runtime;
