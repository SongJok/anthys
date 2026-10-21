CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE ROLE oa_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE oa_queue NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE oa_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE tenants (
 tenant_id uuid PRIMARY KEY, id uuid NOT NULL UNIQUE CHECK(id=tenant_id), corp_id text NOT NULL UNIQUE,
 name text NOT NULL, status text NOT NULL CHECK(status IN ('ACTIVE','SUSPENDED')), policy_version text NOT NULL DEFAULT '1', timezone text NOT NULL DEFAULT 'Asia/Shanghai',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1
);
CREATE TABLE users (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id), id uuid NOT NULL, external_user_id text NOT NULL, union_id text, open_dingtalk_id text,
 display_name text NOT NULL, status text NOT NULL CHECK(status IN ('ACTIVE','DEPARTED','SUSPENDED')), auth_epoch bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,external_user_id)
);
CREATE TABLE departments (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id), id uuid NOT NULL, external_dept_id text NOT NULL, name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,external_dept_id)
);
CREATE TABLE memberships (
 tenant_id uuid NOT NULL, id uuid NOT NULL, department_id uuid NOT NULL, user_id uuid NOT NULL, valid_from timestamptz NOT NULL DEFAULT now(),valid_to timestamptz, source_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,department_id) REFERENCES departments(tenant_id,id), FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX memberships_active ON memberships(tenant_id,department_id,user_id) WHERE valid_to IS NULL;
CREATE TABLE roles (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL, name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,name)
);
CREATE TABLE role_bindings (
 tenant_id uuid NOT NULL,id uuid NOT NULL,role_id uuid NOT NULL,subject_id uuid NOT NULL,scope_kind text NOT NULL,scope_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,role_id) REFERENCES roles(tenant_id,id),FOREIGN KEY(tenant_id,subject_id) REFERENCES users(tenant_id,id),UNIQUE(tenant_id,role_id,subject_id,scope_kind,scope_id)
);
CREATE TABLE identities (
 tenant_id uuid NOT NULL,id uuid NOT NULL, owner_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('HUMAN','SERVICE')),provider text NOT NULL,external_subject text NOT NULL,status text NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id),UNIQUE(tenant_id,provider,external_subject)
);
CREATE TABLE credentials (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,identity_id uuid NOT NULL,ciphertext text NOT NULL,key_version text NOT NULL,expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,identity_id) REFERENCES identities(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE sessions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,token_hash text NOT NULL UNIQUE,csrf_hash text NOT NULL,auth_epoch bigint NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE audit_events (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),id uuid NOT NULL, actor_id uuid NOT NULL, action text NOT NULL,resource text NOT NULL,result text NOT NULL,trace_id text NOT NULL,previous_hash text,hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX audit_time ON audit_events(tenant_id,created_at,id);
CREATE SCHEMA oa_queue AUTHORIZATION oa_queue;
GRANT USAGE ON SCHEMA public TO oa_app,oa_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO oa_app,oa_runtime;
REVOKE UPDATE,DELETE ON audit_events FROM oa_app,oa_runtime;
REVOKE ALL ON credentials FROM oa_app;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON tenants USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON users USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON departments USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON memberships USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON roles USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON role_bindings USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND subject_id = nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND subject_id = nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE identities FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON identities USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id = nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id = nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON credentials USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id = nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id = nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON sessions USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id = nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id = nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON audit_events USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND (actor_id = nullif(current_setting('app.actor_id',true),'')::uuid OR current_setting('app.audit_access',true)='true')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND (actor_id = nullif(current_setting('app.actor_id',true),'')::uuid OR current_setting('app.audit_access',true)='true'));
