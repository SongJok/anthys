-- Broker-bound code/input/output artifacts. Bytes live only in the encrypted
-- file store; this table keeps owner-scoped metadata and hashes. Output rows
-- are written only after the broker verified every output.
CREATE TABLE public.sandbox_artifacts (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 owner_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('CODE','INPUT','OUTPUT')),
 state text NOT NULL CHECK(state IN ('PREPARING','READY','FAILED')),
 job_id uuid,
 name text CHECK(name IS NULL OR name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
 mime text NOT NULL CHECK(mime ~ '^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,63}$'),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 20971520),
 storage_key text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,owner_id,storage_key),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES public.users(tenant_id,id),
 CHECK(isfinite(expires_at)),
 CHECK(kind<>'OUTPUT' OR (job_id IS NOT NULL AND name IS NOT NULL)),
 CHECK(kind='OUTPUT' OR job_id IS NULL)
);
CREATE INDEX sandbox_artifacts_owner ON public.sandbox_artifacts(tenant_id,owner_id,created_at DESC,id);
CREATE UNIQUE INDEX sandbox_artifacts_output_name ON public.sandbox_artifacts(tenant_id,owner_id,job_id,name) WHERE kind='OUTPUT';
ALTER TABLE public.sandbox_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sandbox_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_artifact_owner ON public.sandbox_artifacts USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON public.sandbox_artifacts TO oa_runtime;
