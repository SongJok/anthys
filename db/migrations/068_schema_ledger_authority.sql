-- 001 grants DML on every existing public table, including the ledger created
-- by the migration runner. Application identities must only read that ledger.
-- Do not silently revoke unrelated inherited or column grants: fail the whole
-- migration if those paths exist, so an operator can review their provenance.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.schema_migrations FROM oa_app, oa_runtime;

CREATE FUNCTION public.oa_schema_ledger_read_only() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT (SELECT count(*)=2 FROM pg_roles WHERE rolname IN ('oa_app','oa_runtime'))
  AND NOT EXISTS (
   SELECT 1 FROM pg_roles subject
   JOIN pg_roles reachable ON pg_has_role(subject.oid,reachable.oid,'USAGE') OR pg_has_role(subject.oid,reachable.oid,'SET') OR pg_has_role(subject.oid,reachable.oid,'MEMBER WITH ADMIN OPTION')
   WHERE subject.rolname IN ('oa_app','oa_runtime')
    AND (reachable.oid=(SELECT relowner FROM pg_class WHERE oid='public.schema_migrations'::regclass)
     OR has_table_privilege(reachable.oid,'public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_any_column_privilege(reachable.oid,'public.schema_migrations','INSERT,UPDATE,REFERENCES'))
  );
$$;
REVOKE ALL ON FUNCTION public.oa_schema_ledger_read_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_schema_ledger_read_only() TO oa_app,oa_runtime;

DO $$ BEGIN
 IF NOT public.oa_schema_ledger_read_only() THEN
  RAISE EXCEPTION 'SCHEMA_LEDGER_PRIVILEGES_UNSAFE' USING ERRCODE='42501';
 END IF;
END $$;
