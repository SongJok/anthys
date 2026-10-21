-- Installed by the migration/administration role after independent review.
-- A connector credential alone is never a user's resource authorization.
CREATE TABLE company_code_scopes (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 owner_id uuid NOT NULL,
 connector_id text NOT NULL CHECK(length(connector_id) BETWEEN 1 AND 128),
 repo text NOT NULL CHECK(length(repo) BETWEEN 1 AND 256),
 commit_id text NOT NULL CHECK(commit_id ~ '^[a-f0-9]{40}$'),
 version bigint NOT NULL CHECK(version>0),
 source_revision text NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
 tool_schema_hash text NOT NULL CHECK(tool_schema_hash ~ '^[a-f0-9]{64}$'),
 contract_hash text NOT NULL CHECK(contract_hash ~ '^[a-f0-9]{64}$'),
 readonly_proof_ref text NOT NULL CHECK(length(readonly_proof_ref) BETWEEN 1 AND 2048),
 authorization_proof_ref text NOT NULL CHECK(length(authorization_proof_ref) BETWEEN 1 AND 2048),
 allowed_paths text[] NOT NULL CHECK(cardinality(allowed_paths) BETWEEN 1 AND 64),
 classification text NOT NULL CHECK(classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
 model_egress_allowed boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,owner_id,connector_id,repo,commit_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE company_code_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_code_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY company_code_owner ON company_code_scopes
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON company_code_scopes TO oa_runtime;
CREATE FUNCTION oa_company_scope_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.version<=OLD.version THEN NEW.version=OLD.version+1; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER company_scope_version BEFORE UPDATE ON company_code_scopes
 FOR EACH ROW EXECUTE FUNCTION oa_company_scope_version();
