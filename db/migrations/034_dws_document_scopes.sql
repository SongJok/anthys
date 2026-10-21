-- Reviewed installation by the migration/administration role only. A local
-- grant or successful metadata read is never an upstream body ACL proof.
CREATE TABLE dws_document_scopes (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,
 node_id text NOT NULL CHECK(node_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 payload_profile jsonb NOT NULL,
 binary_hash text NOT NULL CHECK(binary_hash ~ '^[a-f0-9]{64}$'),
 schema_hash text NOT NULL CHECK(schema_hash ~ '^[a-f0-9]{64}$'),
 contract_hash text NOT NULL CHECK(contract_hash ~ '^[a-f0-9]{64}$'),
 authorization_review_ref text NOT NULL CHECK(length(authorization_review_ref) BETWEEN 1 AND 2048),
 classification text NOT NULL CHECK(classification IN ('CONFIDENTIAL','RESTRICTED')),
 model_egress_allowed boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,node_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE dws_document_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE dws_document_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON dws_document_scopes USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT ON dws_document_scopes TO oa_runtime;
CREATE FUNCTION oa_dws_document_scope_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.version<=OLD.version THEN NEW.version=OLD.version+1; END IF; RETURN NEW; END $$;
CREATE TRIGGER dws_document_scope_version BEFORE UPDATE ON dws_document_scopes FOR EACH ROW EXECUTE FUNCTION oa_dws_document_scope_version();
