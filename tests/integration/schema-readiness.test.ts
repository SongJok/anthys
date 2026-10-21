import {requiredSchema} from '../../packages/storage/src/schema.js';
import '../support/isolation.js';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Database} from '../../packages/storage/src/database.js';
import {config,secret} from '../../packages/config/src/index.js';
import {createServer} from '../../apps/api/src/server.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('DATABASE_URL')!,1),runtime=new Database(secret('RUNTIME_DATABASE_URL')!,1);
afterAll(async()=>{await db.close();await runtime.close();await root.end();});
// Changes are visible only on this transaction's actual PostgreSQL connection.
// Forward the application's query there; no fake rows, committed metadata edits,
// production migration, or interference with another test's readiness checks.
async function transaction(test:(c:pg.PoolClient)=>Promise<void>){const c=await root.connect();await c.query('BEGIN');const spy=vi.spyOn(db.pool,'query').mockImplementation(c.query.bind(c) as typeof db.pool.query);try{await test(c);}finally{spy.mockRestore();await c.query('ROLLBACK');c.release();}}
const latest=requiredSchema.lastMigration;
const before068=requiredSchema.migrations.filter(m=>Number(m.name.slice(0,3))<68);
async function assertBefore068(c:pg.PoolClient){expect(before068).toHaveLength(67);expect((await c.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows).toEqual(before068);}
async function prepareBefore068(c:pg.PoolClient){await c.query('DELETE FROM public.schema_migrations WHERE name=ANY($1::text[])',[requiredSchema.migrations.filter(m=>Number(m.name.slice(0,3))>=68).map(m=>m.name)]);await assertBefore068(c);}

it('the exact current schema is ready through actual app/runtime roles',async()=>{expect(await db.ready()).toBe(true);expect(await runtime.ready()).toBe(true);});
it.each(['latest','first','only-first','wrong-hash','substituted','future'])('real migration metadata %s cannot advertise readiness',async kind=>transaction(async c=>{
 if(kind==='latest'||kind==='substituted')await c.query('DELETE FROM public.schema_migrations WHERE name=$1',[latest]);
 if(kind==='first')await c.query("DELETE FROM public.schema_migrations WHERE name='001_identity.sql'");
 if(kind==='only-first')await c.query("DELETE FROM public.schema_migrations WHERE name<>'001_identity.sql'");
 if(kind==='wrong-hash')await c.query('UPDATE public.schema_migrations SET hash=$2 WHERE name=$1',[latest,'0'.repeat(64)]);
 if(kind==='substituted'||kind==='future')await c.query("INSERT INTO public.schema_migrations(name,hash) VALUES('999_unreviewed.sql',$1)",['0'.repeat(64)]);
 expect(await db.ready()).toBe(false);
}));
it('an empty migration history remains not ready',async()=>transaction(async c=>{await c.query('DELETE FROM public.schema_migrations');expect(await db.ready()).toBe(false);}));
it('temporary search_path metadata cannot replace public migration authority',async()=>transaction(async c=>{await c.query('DELETE FROM public.schema_migrations WHERE name=$1',[latest]);await c.query('CREATE TEMP TABLE schema_migrations(name text,hash text) ON COMMIT DROP');await c.query("INSERT INTO pg_temp.schema_migrations VALUES('fake', 'fake')");expect(await db.ready()).toBe(false);}));
it('HTTP readiness returns503 for missing required schema while liveness stays200',async()=>transaction(async c=>{
 await c.query('DELETE FROM public.schema_migrations WHERE name=$1',[latest]);const api=await createServer({config:config({APP_ENV:'test'}),db,sessionSecret:randomBytes(32).toString('hex')});try{expect((await api.app.inject('/api/v1/health/live')).statusCode).toBe(200);const response=await api.app.inject('/api/v1/health/ready');expect(response.statusCode).toBe(503);expect(response.json()).toEqual({data:{status:'NOT_READY',dependency:'database/schema'}});expect(response.payload).not.toContain(latest);}finally{await api.app.close();}
}));

it.each(['oa_app','oa_runtime'] as const)('%s cannot modify the migration authority using actual credentials',async role=>{
 const connection=await (role==='oa_app'?db:runtime).pool.connect();
 try{
  for(const statement of ["INSERT INTO public.schema_migrations(name,hash) VALUES('999_forbidden.sql','forbidden')","UPDATE public.schema_migrations SET hash='forbidden' WHERE name='001_identity.sql'","DELETE FROM public.schema_migrations WHERE name='001_identity.sql'","TRUNCATE public.schema_migrations"]){
   await connection.query('BEGIN');
   try{await expect(connection.query(statement)).rejects.toMatchObject({code:'42501'});}
   finally{await connection.query('ROLLBACK');}
  }
 }finally{connection.release();}
 expect(await db.ready()).toBe(true);expect(await runtime.ready()).toBe(true);
});
it.each(['table','column','set-role','public','owner-regrant','owner-inherited','owner-set-role','owner-admin'] as const)('readiness rejects a %s path to writing migration metadata',async kind=>transaction(async c=>{
 if(kind==='table')await c.query('GRANT UPDATE ON public.schema_migrations TO oa_app');
 if(kind==='column')await c.query('GRANT UPDATE(hash) ON public.schema_migrations TO oa_runtime');
 if(kind==='public')await c.query('GRANT UPDATE ON public.schema_migrations TO PUBLIC');
 if(kind==='owner-regrant'){
  await c.query('ALTER TABLE public.schema_migrations OWNER TO oa_app');
  await c.query('REVOKE ALL ON public.schema_migrations FROM oa_app');
  await c.query('GRANT SELECT ON public.schema_migrations TO oa_app');
  expect((await c.query("SELECT has_table_privilege('oa_app','schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') writable")).rows).toEqual([{writable:false}]);
  await c.query('SAVEPOINT owner_regrant');await c.query('SET LOCAL ROLE oa_app');
  await c.query('GRANT UPDATE ON public.schema_migrations TO oa_app');
  expect((await c.query("UPDATE public.schema_migrations SET hash=hash WHERE name='001_identity.sql'")).rowCount).toBe(1);
  await c.query('ROLLBACK TO SAVEPOINT owner_regrant');
 }
 if(['owner-inherited','owner-set-role','owner-admin'].includes(kind)){
  await c.query('CREATE ROLE oa_ledger_owner_negative NOLOGIN');
  await c.query('ALTER TABLE public.schema_migrations OWNER TO oa_ledger_owner_negative');
  await c.query('REVOKE ALL ON public.schema_migrations FROM oa_ledger_owner_negative');
  const options=kind==='owner-inherited'?'ADMIN FALSE, INHERIT TRUE, SET FALSE':kind==='owner-set-role'?'ADMIN FALSE, INHERIT FALSE, SET TRUE':'ADMIN TRUE, INHERIT FALSE, SET FALSE';
  await c.query('GRANT oa_ledger_owner_negative TO oa_app WITH '+options);
  if(kind==='owner-admin'){
   expect((await c.query("SELECT pg_has_role('oa_app','oa_ledger_owner_negative','USAGE') inherited,pg_has_role('oa_app','oa_ledger_owner_negative','SET') set_role,pg_has_role('oa_app','oa_ledger_owner_negative','MEMBER WITH ADMIN OPTION') admin")).rows).toEqual([{inherited:false,set_role:false,admin:true}]);
   await c.query('SAVEPOINT owner_admin_regrant');await c.query('SET LOCAL ROLE oa_app');
   await c.query('GRANT oa_ledger_owner_negative TO oa_app WITH SET TRUE');
   expect((await c.query("SELECT pg_has_role('oa_app','oa_ledger_owner_negative','SET') reachable")).rows).toEqual([{reachable:true}]);
   await c.query('ROLLBACK TO SAVEPOINT owner_admin_regrant');
  }
 }
 if(kind==='set-role'){
  // Transaction-only synthetic role: no other connection can observe membership.
  await c.query('CREATE ROLE oa_ledger_readiness_negative NOLOGIN');
  await c.query('GRANT UPDATE ON public.schema_migrations TO oa_ledger_readiness_negative');
  await c.query('GRANT oa_ledger_readiness_negative TO oa_app WITH INHERIT FALSE, SET TRUE');
 }
 expect(await db.ready()).toBe(false);
}));
it('the actual 068 SQL preserves SELECT and existing credentials',async()=>transaction(async c=>{
 const before=await c.query("SELECT rolname,rolpassword,rolcanlogin FROM pg_authid WHERE rolname IN ('oa_app','oa_runtime','oa_queue','oa_migrator') ORDER BY rolname");
 await c.query('DROP FUNCTION public.oa_schema_ledger_read_only()');
 await c.query('GRANT INSERT,UPDATE,DELETE ON public.schema_migrations TO oa_app,oa_runtime');
 await c.query('GRANT UPDATE(hash) ON public.schema_migrations TO oa_runtime');
 await c.query(await readFile('db/migrations/068_schema_ledger_authority.sql','utf8'));
 expect(await db.ready()).toBe(true);
 expect((await c.query("SELECT has_table_privilege('oa_app','public.schema_migrations','SELECT') app_select,has_table_privilege('oa_runtime','public.schema_migrations','SELECT') runtime_select,public.oa_schema_ledger_read_only() safe")).rows).toEqual([{app_select:true,runtime_select:true,safe:true}]);
 expect((await c.query("SELECT rolname,rolpassword,rolcanlogin FROM pg_authid WHERE rolname IN ('oa_app','oa_runtime','oa_queue','oa_migrator') ORDER BY rolname")).rows).toEqual(before.rows);
}));
it.each(['column','set-role','public'] as const)('068 stops and rolls back when a preexisting %s write path survives the scoped REVOKE',async kind=>transaction(async c=>{
 await c.query('DROP FUNCTION public.oa_schema_ledger_read_only()');
 await prepareBefore068(c);
 await c.query('GRANT INSERT,UPDATE,DELETE ON public.schema_migrations TO oa_app,oa_runtime');
 await c.query('CREATE ROLE oa_ledger_migration_negative NOLOGIN');
 if(kind==='column'){
  // PostgreSQL table REVOKE also removes corresponding direct column grants.
  // A column grant on a different inherited role genuinely survives this REVOKE.
  await c.query('GRANT UPDATE(hash) ON public.schema_migrations TO oa_ledger_migration_negative');
  await c.query('GRANT oa_ledger_migration_negative TO oa_runtime WITH INHERIT TRUE, SET FALSE');
  expect((await c.query("SELECT has_column_privilege('oa_ledger_migration_negative','public.schema_migrations','hash','UPDATE') column_write,pg_has_role('oa_runtime','oa_ledger_migration_negative','USAGE') inherited")).rows).toEqual([{column_write:true,inherited:true}]);
 }else if(kind==='set-role'){
  await c.query('GRANT UPDATE ON public.schema_migrations TO oa_ledger_migration_negative');
  await c.query('GRANT oa_ledger_migration_negative TO oa_app WITH INHERIT FALSE, SET TRUE');
 }else await c.query('GRANT UPDATE ON public.schema_migrations TO PUBLIC');
 await c.query('SAVEPOINT migration_068');
 await expect(c.query(await readFile('db/migrations/068_schema_ledger_authority.sql','utf8'))).rejects.toMatchObject({code:'42501',message:'SCHEMA_LEDGER_PRIVILEGES_UNSAFE'});
 await c.query('ROLLBACK TO SAVEPOINT migration_068');await assertBefore068(c);
 const state=await c.query("SELECT (SELECT count(*)::int FROM schema_migrations) prefix,has_table_privilege('oa_app','schema_migrations','INSERT') revoke_rolled_back,to_regprocedure('public.oa_schema_ledger_read_only()') IS NULL function_rolled_back");
 expect(state.rows).toEqual([{prefix:before068.length,revoke_rolled_back:true,function_rolled_back:true}]);
}));
it.each(['missing-guard','writable-ledger'] as const)('HTTP readiness returns503 for %s and keeps liveness available',async kind=>transaction(async c=>{
 if(kind==='missing-guard')await c.query('DROP FUNCTION public.oa_schema_ledger_read_only()');
 else await c.query('GRANT UPDATE ON public.schema_migrations TO PUBLIC');
 const api=await createServer({config:config({APP_ENV:'test'}),db,sessionSecret:randomBytes(32).toString('hex')});
 try{
  expect((await api.app.inject('/api/v1/health/live')).statusCode).toBe(200);
  const response=await api.app.inject('/api/v1/health/ready');expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({data:{status:'NOT_READY',dependency:'database/schema'}});
  expect(response.payload).not.toMatch(/schema_migrations|oa_schema_ledger|oa_runtime|oa_app/);
 }finally{await api.app.close();}
}));
it('068 rejects an application-owned ledger despite revoked ordinary writes and rolls back its complete transaction',async()=>transaction(async c=>{
 await c.query('DROP FUNCTION public.oa_schema_ledger_read_only()');await prepareBefore068(c);
 await c.query('ALTER TABLE schema_migrations OWNER TO oa_app');await c.query('REVOKE ALL ON schema_migrations FROM oa_app');await c.query('GRANT SELECT ON schema_migrations TO oa_app');await c.query('GRANT INSERT,UPDATE,DELETE ON schema_migrations TO oa_runtime');
 await c.query('SAVEPOINT misowned_068');
 await expect(c.query(await readFile('db/migrations/068_schema_ledger_authority.sql','utf8'))).rejects.toMatchObject({code:'42501',message:'SCHEMA_LEDGER_PRIVILEGES_UNSAFE'});
 await c.query('ROLLBACK TO SAVEPOINT misowned_068');await assertBefore068(c);
 expect((await c.query("SELECT (SELECT count(*)::int FROM schema_migrations) prefix,to_regprocedure('public.oa_schema_ledger_read_only()') IS NULL function_rolled_back,has_table_privilege('oa_runtime','schema_migrations','INSERT') runtime_revoke_rolled_back,(SELECT relowner='oa_app'::regrole FROM pg_class WHERE oid='schema_migrations'::regclass) owner_preserved")).rows).toEqual([{prefix:67,function_rolled_back:true,runtime_revoke_rolled_back:true,owner_preserved:true}]);
}));
