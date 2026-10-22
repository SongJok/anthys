import {readFile,readdir} from 'node:fs/promises';
import {schemaOnlyRejection} from '../support/group-reminder-database.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';

const rejected=(sql:string)=>schemaOnlyRejection(sql)==='TEST_SCHEMA_CLUSTER_OPERATION_REJECTED';

it('the current migration set carries no data or cluster operation the schema-only scan accepts',async()=>{
 const names=(await readdir('db/migrations')).filter(name=>name.endsWith('.sql')).sort();
 expect(names).toEqual(requiredSchema.migrations.map(migration=>migration.name));
 for(const name of names.slice(94)){
  const sql=await readFile('db/migrations/'+name,'utf8');
  expect(schemaOnlyRejection(sql),name).toBeNull();
 }
});
it('a reviewed schema-only DO block is accepted and any other DO block is rejected',()=>{
 const reviewed=" DO $$ DECLARE item record;\nBEGIN\n FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='public.role_bindings'::regclass AND contype='u'\n  AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, role_id, subject_id, scope_kind, scope_id)'\n LOOP EXECUTE format('ALTER TABLE public.role_bindings DROP CONSTRAINT %I',item.conname);END LOOP;\nEND $$;";
 expect(schemaOnlyRejection(reviewed)).toBeNull();
 expect(rejected(" DO $$ BEGIN DELETE FROM public.tasks; END $$;")).toBe(true);
 expect(rejected(" DO $$ BEGIN CREATE ROLE oa_other NOLOGIN; END $$;")).toBe(true);
 expect(rejected(" DO $$ BEGIN UPDATE public.role_bindings SET scope_id='x'; END $$;")).toBe(true);
 expect(rejected(" DO $$ BEGIN PERFORM 1; END $$;")).toBe(true);
});
it('data, role and session operations stay rejected by the schema-only scan',()=>{
 for(const sql of [
  'INSERT INTO public.tenants(tenant_id) VALUES($1);',
  'UPDATE public.tenants SET status=$1;',
  'DELETE FROM public.tenants;',
  'TRUNCATE public.tenants;',
  'CREATE ROLE oa_other NOLOGIN;',
  'ALTER ROLE oa_app SUPERUSER;',
  'DROP DATABASE anthys_test;',
  'SET ROLE oa_app;',
  'SET SESSION AUTHORIZATION oa_app;',
  'GRANT oa_app;',
  'SELECT count(*) FROM public.tenants;',
  'CALL public.oa_permission_admin_authority($1);',
  'COPY public.tenants TO STDOUT;',
  'REASSIGN OWNED BY oa_app TO oa_migrator;',
 ])expect(rejected(sql),sql).toBe(true);
 expect(schemaOnlyRejection('CREATE TABLE public.example(id uuid PRIMARY KEY);')).toBeNull();
 expect(schemaOnlyRejection('GRANT SELECT ON public.tenants TO oa_app;')).toBeNull();
 expect(schemaOnlyRejection("SELECT pg_catalog.set_config('app.tenant_id','x',false);")).toBeNull();
});
