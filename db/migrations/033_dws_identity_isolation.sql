CREATE TABLE dws_authorization_epochs (
 tenant_id uuid NOT NULL,owner_id uuid NOT NULL,generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 PRIMARY KEY(tenant_id,owner_id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE dws_authorization_epochs ENABLE ROW LEVEL SECURITY;ALTER TABLE dws_authorization_epochs FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON dws_authorization_epochs USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON dws_authorization_epochs TO oa_runtime;
CREATE TABLE dws_identities (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,
 corp_id text NOT NULL,external_user_id text NOT NULL,auth_epoch bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('VERIFYING','CONNECTED','AUTH_REQUIRED','REVOKED','UNVERIFIED')),
 authorization_version bigint NOT NULL DEFAULT 1 CHECK(authorization_version>0),
 credential_version bigint NOT NULL DEFAULT 1 CHECK(credential_version>0),
 credentials_ref jsonb,model_egress_allowed boolean NOT NULL DEFAULT false,
 binary_hash text NOT NULL,delegation_expires_at timestamptz NOT NULL,
 verified_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id),UNIQUE(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),
 CHECK(state<>'CONNECTED' OR credentials_ref IS NOT NULL),CHECK(state<>'REVOKED' OR credentials_ref IS NULL)
);
ALTER TABLE dws_identities ENABLE ROW LEVEL SECURITY;ALTER TABLE dws_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON dws_identities USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON dws_identities TO oa_runtime;
GRANT SELECT(tenant_id,id,owner_id,state,authorization_version,model_egress_allowed,delegation_expires_at,verified_at) ON dws_identities TO oa_app;
CREATE FUNCTION oa_dws_authorization_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.corp_id,NEW.external_user_id,NEW.auth_epoch,NEW.state,NEW.model_egress_allowed,NEW.delegation_expires_at)
  IS DISTINCT FROM (OLD.corp_id,OLD.external_user_id,OLD.auth_epoch,OLD.state,OLD.model_egress_allowed,OLD.delegation_expires_at)
 THEN NEW.authorization_version=greatest(OLD.authorization_version+1,NEW.authorization_version);
 ELSIF NEW.authorization_version<OLD.authorization_version THEN RAISE EXCEPTION 'DWS authorization version cannot decrease'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dws_authorization_version BEFORE UPDATE ON dws_identities FOR EACH ROW EXECUTE FUNCTION oa_dws_authorization_version();
CREATE TABLE run_dws_dependencies (
 tenant_id uuid NOT NULL,owner_id uuid NOT NULL,run_id uuid NOT NULL,session_no bigint NOT NULL CHECK(session_no BETWEEN 1 AND 32),
 identity_id uuid NOT NULL,authorization_version bigint NOT NULL,
 PRIMARY KEY(tenant_id,run_id,session_no,identity_id),
 FOREIGN KEY(tenant_id,run_id,owner_id) REFERENCES runs(tenant_id,id,owner_id),
 FOREIGN KEY(tenant_id,identity_id,owner_id) REFERENCES dws_identities(tenant_id,id,owner_id)
);
ALTER TABLE run_dws_dependencies ENABLE ROW LEVEL SECURITY;ALTER TABLE run_dws_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON run_dws_dependencies USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON run_dws_dependencies TO oa_runtime;
