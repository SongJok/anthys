import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {groupReminderDatabase} from './group-reminder-database.js';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const roleCreation=['oa_app','oa_queue','oa_runtime'].map(role=>`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`);
async function clusterState(client:pg.Client|pg.PoolClient){
 const roles=(await client.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles ORDER BY rolname")).rows;
 const memberships=(await client.query('SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows;
 if(!roleCreation.every((_,i)=>roles.some(r=>r.rolname===['oa_app','oa_queue','oa_runtime'][i])))throw Error('HISTORICAL_FIXTURE_EXISTING_ROLES_REQUIRED');
 return digest(JSON.stringify({roles,memberships}));
}
/** Test-only historical schema reconstruction in a freshly created own nonce.
 * Source schema/rows and cluster roles are never changed. This is not an
 * operator rollback, and no connection target or prefix is accepted from callers.
 */
export async function historicalMigrationDatabase(prefix:73|94=94){
 if(prefix!==73&&prefix!==94)throw Error('HISTORICAL_FIXTURE_PREFIX_REJECTED');
 const own=await groupReminderDatabase();
 const source=new pg.Client({connectionString:process.env['MIGRATION_DATABASE_URL'],connectionTimeoutMillis:3000,query_timeout:12000});
 let connected=false;
 try{
  await source.connect();connected=true;
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const sourceIdentity=(await source.query("SELECT current_database() name,current_user actor,(SELECT system_identifier::text FROM pg_control_system()) system")).rows[0];
  if(sourceIdentity.name!=='anthys_test'||sourceIdentity.actor!=='oa_migrator')throw Error('HISTORICAL_FIXTURE_SOURCE_REJECTED');
  const sourceBefore=digest(JSON.stringify((await source.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows));
  const clusterBefore=await clusterState(source);await source.query('COMMIT');
  // Always reproduce CI: first bring this own clone to the CURRENT source.
  await own.install();
  const current=(await own.root.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows;
  if(JSON.stringify(current)!==JSON.stringify(requiredSchema.migrations))throw Error('HISTORICAL_FIXTURE_CURRENT_SCHEMA_REQUIRED');
  const url=new URL(own.connectionString);
  if(url.hostname!=='127.0.0.1'||url.port!=='64711'||url.pathname!=='/'+own.name||url.username!=='oa_migrator'||!/^anthys_test_group_reminder_[a-f0-9]{32}$/.test(own.name))throw Error('HISTORICAL_FIXTURE_OWN_NONCE_REQUIRED');
  const definitions=[];
  for(const [index,migration] of requiredSchema.migrations.slice(0,prefix).entries()){
   let sql=await readFile('db/migrations/'+migration.name,'utf8');
   if(digest(sql)!==migration.hash||Number(migration.name.slice(0,3))!==index+1)throw Error('HISTORICAL_FIXTURE_SQL_DRIFT');
   // Global roles already exist. Omit ONLY the three exact canonical CREATE
   // ROLE statements; retain their original canonical SQL hashes in the ledger.
   if(index===0)for(const statement of roleCreation){if(sql.split(statement).length!==2)throw Error('HISTORICAL_FIXTURE_ROLE_STATEMENT_DRIFT');sql=sql.replace(statement,'');}
   if(/^\s*(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b/im.test(sql))throw Error('HISTORICAL_FIXTURE_GLOBAL_ROLE_OPERATION_REJECTED');
   definitions.push({...migration,sql});
  }
  const client=await own.root.connect();
  try{
   await client.query('BEGIN');
   await client.query("SELECT pg_advisory_xact_lock(hashtext('anthys_migrations'))");
   const identity=(await client.query("SELECT current_database() name,current_user actor,(SELECT system_identifier::text FROM pg_control_system()) system")).rows[0];
   if(identity.name!==own.name||identity.actor!=='oa_migrator'||identity.system!==sourceIdentity.system||await clusterState(client)!==clusterBefore)throw Error('HISTORICAL_FIXTURE_IDENTITY_CHANGED');
   if((await client.query('SELECT EXISTS(SELECT 1 FROM public.tenants) present')).rows[0].present===true)throw Error('HISTORICAL_FIXTURE_EMPTY_CLONE_REQUIRED');
   await client.query('DROP SCHEMA public CASCADE');
   await client.query('DROP SCHEMA oa_queue CASCADE');
   await client.query('CREATE SCHEMA public AUTHORIZATION oa_migrator');
   await client.query('CREATE TABLE public.schema_migrations(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
   for(const migration of definitions){await client.query(migration.sql);await client.query('INSERT INTO public.schema_migrations(name,hash) VALUES($1,$2)',[migration.name,migration.hash]);}
   await client.query('GRANT SELECT ON public.schema_migrations TO oa_app,oa_runtime');
   if(await clusterState(client)!==clusterBefore)throw Error('HISTORICAL_FIXTURE_CLUSTER_STATE_CHANGED');
   const ledger=(await client.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows;
   if(JSON.stringify(ledger)!==JSON.stringify(requiredSchema.migrations.slice(0,prefix))||(await client.query("SELECT to_regclass('public.group_reminder_authorizations') present")).rows[0].present!==null)throw Error('HISTORICAL_FIXTURE_NOT_EXACT_PREFIX');
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await source.query('BEGIN READ ONLY');
  const sourceAfter=digest(JSON.stringify((await source.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows));
  const clusterAfter=await clusterState(source);await source.query('COMMIT');
  if(sourceBefore!==sourceAfter||clusterBefore!==clusterAfter)throw Error('HISTORICAL_FIXTURE_SHARED_STATE_CHANGED');
  return {...own,historicalEvidence:{installedCurrent:current.length,historicalPrefix:prefix,sourceBefore,sourceAfter,clusterBefore,clusterAfter}};
 }catch(error){await own.close();throw error;}finally{if(connected)await source.query('ROLLBACK').catch(()=>{});await source.end().catch(()=>{});}
}
