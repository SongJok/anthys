import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {Database} from '../../packages/storage/src/database.js';

const sourceName='open_aider_test',migration95='095_group_reminder_authority.sql',migration96='096_group_reminder_execution.sql',migration97='097_task_result_artifacts.sql',migration98='098_company_agent_requests.sql',migration99='099_native_case_audiences.sql',migration100='100_formal_group_admission.sql',migration101='101_group_mention_contract_observer.sql',migration102='102_native_artifact_drafts.sql',migration103='103_group_case_escalations.sql',migration104='104_finite_private_pilots.sql';
const roles=[['MIGRATION_DATABASE_URL','oa_migrator'],['RUNTIME_DATABASE_URL','oa_runtime'],['DATABASE_URL','oa_app']] as const;
const image='postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826';
const maxBytes=64*1024*1024;
class SafetyError extends Error{
 ownDatabaseName?:string;
 creationState?:'UNKNOWN'|'CONFIRMED';
}
function fail(code:string):never{throw new SafetyError(code);}
const safe=(error:unknown,code:string)=>error instanceof SafetyError?error:new SafetyError(code);
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
type Ledger={name:string;hash:string}[];

function targets(){
 if(process.env['APP_ENV']!=='test'||process.env['OA_TEST_ISOLATED']!=='true'||Reflect.get(globalThis,Symbol.for('open_aider.testNetworkGuard'))!==true)fail('TEST_ISOLATION_REQUIRED');
 const urls=new Map<string,URL>();
 for(const [key,role] of roles){
  const text=process.env[key];if(!text||text.length>8192||process.env[key+'_FILE'])fail('TEST_DATABASE_TARGET_REJECTED');
  let url:URL;try{url=new URL(text);}catch{fail('TEST_DATABASE_TARGET_REJECTED');}
  let password:string;try{password=decodeURIComponent(url.password);}catch{fail('TEST_DATABASE_TARGET_REJECTED');}
  if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.port!=='53331'||url.pathname!=='/'+sourceName||url.username!==role||url.search||url.hash||text.includes('?')||text.includes('#')||password.length<32||/[\u0000-\u001f\u007f]/.test(password))fail('TEST_DATABASE_TARGET_REJECTED');
  urls.set(key,url);
 }
 return urls;
}
function dockerEnv(){return {PATH:process.env['PATH']??'/usr/bin:/bin',...(process.env['HOME']?{HOME:process.env['HOME']}:{}),...(process.env['DOCKER_CONFIG']?{DOCKER_CONFIG:process.env['DOCKER_CONFIG']}:{})};}
function docker(args:string[],input?:Buffer):Buffer{
 try{return execFileSync('docker',args,{env:dockerEnv(),stdio:['pipe','pipe','pipe'],timeout:30000,maxBuffer:maxBytes,...(input?{input}:{})});}catch{fail('TEST_DOCKER_COMMAND_FAILED');}
}
function unixEndpoint(value:unknown):string{
 if(typeof value!=='string'||!/^unix:\/\/\/[^\s\u0000-\u001f?#%]+$/.test(value)||value.includes('/../')||value.includes('/./'))fail('TEST_DOCKER_ENDPOINT_REJECTED');
 return value;
}
function localDocker(){
 if(process.env['DOCKER_TLS_VERIFY']||process.env['DOCKER_CERT_PATH'])fail('TEST_DOCKER_ENDPOINT_REJECTED');
 const supplied=process.env['DOCKER_HOST'];if(supplied)unixEndpoint(supplied);
 const context=process.env['DOCKER_CONTEXT']??docker(['context','show']).toString('utf8').trim();
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context))fail('TEST_DOCKER_ENDPOINT_REJECTED');
 let endpoint:string;try{endpoint=unixEndpoint(JSON.parse(docker(['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}']).toString('utf8')));}catch(e){throw safe(e,'TEST_DOCKER_ENDPOINT_REJECTED');}
 if(supplied&&supplied!==endpoint)fail('TEST_DOCKER_ENDPOINT_REJECTED');
 const prefix=['--host',endpoint],ids=docker([...prefix,'ps','--filter','label=com.docker.compose.project=open-aider-test','--filter','label=com.docker.compose.service=postgres','--filter','publish=53331','--format','{{.ID}}']).toString('utf8').trim().split(/\s+/).filter(Boolean);
 if(ids.length!==1||!/^[a-f0-9]{12,64}$/.test(ids[0]!))fail('TEST_DOCKER_CONTAINER_REJECTED');
 let info:Record<string,unknown>;try{const parsed:unknown=JSON.parse(docker([...prefix,'inspect',ids[0]!,'--format','{{json .}}']).toString('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('TEST_DOCKER_CONTAINER_REJECTED');info=parsed as Record<string,unknown>;}catch{fail('TEST_DOCKER_CONTAINER_REJECTED');}
 const config=info['Config'] as {Image?:unknown;Labels?:Record<string,string>}|undefined,state=info['State'] as {Running?:unknown}|undefined;
 const ports=(info['NetworkSettings'] as {Ports?:Record<string,unknown>}|undefined)?.Ports,bindings=ports?.['5432/tcp'];
 if(config?.Image!==image||config.Labels?.['com.docker.compose.project']!=='open-aider-test'||config.Labels?.['com.docker.compose.service']!=='postgres'||state?.Running!==true
  ||!Array.isArray(bindings)||bindings.length!==1||bindings[0]?.HostIp!=='127.0.0.1'||bindings[0]?.HostPort!=='53331')fail('TEST_DOCKER_CONTAINER_REJECTED');
 return (command:string[],input?:Buffer)=>docker([...prefix,'exec',...(input?['-i']:[]),ids[0]!,...command],input);
}
/** Inspect top-level commands, preserving quoted function bodies and faithful object ACLs. */
function schemaOnly(sql:string){
 let statement='';
 const check=()=>{
  const code=statement.trim().toUpperCase();statement='';if(!code)return;
  if(/^(?:CREATE|ALTER|DROP)\s+(?:(?:OR\s+REPLACE\s+)?(?:ROLE|USER|GROUP|DATABASE|TABLESPACE|SUBSCRIPTION)|SYSTEM)\b|^(?:REASSIGN|DROP)\s+OWNED\b|^(?:DO|CALL|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b|^SET\s+(?:ROLE|SESSION\s+AUTHORIZATION)\b/.test(code))fail('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');
  if(/^(?:GRANT|REVOKE)\b/.test(code)&&!/\bON\b/.test(code))fail('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');
  if(/^SELECT\b/.test(code)&&!/^SELECT\s+PG_CATALOG\.SET_CONFIG\s*\(\s*_STRING_\s*,\s*_STRING_\s*,\s*(?:TRUE|FALSE)\s*\)$/.test(code))fail('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');
 };
 for(let i=0;i<sql.length;){
  if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end;statement+=' ';continue;}
  if(sql.startsWith('/*',i)){
   let depth=1;i+=2;while(i<sql.length&&depth){if(sql.startsWith('/*',i)){depth++;i+=2;}else if(sql.startsWith('*/',i)){depth--;i+=2;}else i++;}
   if(depth)fail('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');statement+=' ';continue;
  }
  const ch=sql[i]!;
  if(ch==='\\'){
   const end=sql.indexOf('\n',i),line=sql.slice(i,end<0?sql.length:end).trim();
   if(statement.trim()||!/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line))fail('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');
   i=end<0?sql.length:end;continue;
  }
  if(ch==="'"||ch==='"'){
   const escape=ch==="'"&&/(?:^|[^A-Za-z0-9_$])[eE]$/.test(statement);let ended=false;i++;
   while(i<sql.length){if(escape&&sql[i]==='\\'){i+=2;continue;}if(sql[i]===ch){if(sql[i+1]===ch){i+=2;continue;}i++;ended=true;break;}i++;}
   if(!ended)fail('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');statement+=ch==="'"?'_STRING_':'_IDENT_';continue;
  }
  if(ch==='$'){
   const tag=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
   if(tag){const end=sql.indexOf(tag,i+tag.length);if(end<0)fail('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');statement+='_BODY_';i=end+tag.length;continue;}
  }
  if(ch===';'){check();i++;continue;}statement+=ch;i++;
 }
 check();
}
async function files(){
 const names=(await readdir('db/migrations')).filter(n=>/^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort().filter(n=>Number(n.slice(0,3))<=104);
 if(![95,96,97,98,99,100,101,102,103,104].includes(names.length)||names.some((n,i)=>Number(n.slice(0,3))!==i+1)||names[94]!==migration95||names.length>=96&&names[95]!==migration96||names.length>=97&&names[96]!==migration97||names.length>=98&&names[97]!==migration98||names.length>=99&&names[98]!==migration99||names.length>=100&&names[99]!==migration100||names.length>=101&&names[100]!==migration101||names.length>=102&&names[101]!==migration102||names.length>=103&&names[102]!==migration103||names.length===104&&names[103]!==migration104)fail('TEST_SCHEMA_FILES_REJECTED');
 const result=[];for(const name of names){const sql=await readFile('db/migrations/'+name,'utf8');result.push({name,hash:digest(sql),sql});}return result;
}
function ledger(raw:unknown,expected:{name:string;hash:string}[]):Ledger{
 if(!Array.isArray(raw)||![94,95,96,97,98,99,100,101,102,103,104].includes(raw.length)||raw.length>expected.length)fail('TEST_SCHEMA_LEDGER_REJECTED');
 const parsed=raw as Ledger;
 if(parsed.some((r,i)=>!r||r.name!==expected[i]?.name||r.hash!==expected[i]?.hash)||new Set(parsed.map(r=>r.name)).size!==parsed.length)fail('TEST_SCHEMA_LEDGER_REJECTED');
 return parsed.map(r=>({name:r.name,hash:r.hash}));
}
async function identity(c:pg.Client|pg.PoolClient,database:string,system?:string){
 const row=(await c.query("SELECT current_user AS role,current_database() AS database,(SELECT system_identifier::text FROM pg_control_system()) AS system")).rows[0];
 if(row?.role!=='oa_migrator'||row.database!==database||!/^\d+$/.test(row.system as string)||system&&row.system!==system)fail('TEST_CLUSTER_IDENTITY_REJECTED');return row.system as string;
}

/** Initial shared-source clone is schema-only. Full dump/destruction/restore
 * methods operate solely on confirmed own synthetic nonces, never shared rows
 * or roles, and only restore bytes issued by this fixture. */
export async function groupReminderDatabase(){
 const original=targets(),run=localDocker(),definitions=await files();
 const name='open_aider_test_group_reminder_'+randomUUID().replaceAll('-','');
 if(!/^open_aider_test_group_reminder_[a-f0-9]{32}$/.test(name)||Buffer.byteLength(name)>63)fail('TEST_DATABASE_NAME_REJECTED');
 const url=(key:string,database:string)=>{const value=new URL(original.get(key)!);value.pathname='/'+database;return value.href;};
 const options=(database:string)=>({connectionString:url('MIGRATION_DATABASE_URL',database),connectionTimeoutMillis:3000,query_timeout:12000});
 let created=false,creationAttempted=false,closed=false,closing=false,poolsClosed=false,sourceDisposed=false,sourceDisposing=false,cleanup:Promise<void>|null=null,installing:Promise<string>|null=null,sourceClose:Promise<void>|null=null;
 let root:pg.Pool|undefined,db:Database|undefined,appDb:Database|undefined,system='';
 let emptyRestoreTargetsIssued=0;
 const restoredNames=new Set<string>(),restoredPools:pg.Pool[]=[],issuedArchives=new Set<string>();
 const jobs=new Set<Promise<unknown>>();
 const closeSourcePools=()=>sourceClose??=(async()=>{const results=await Promise.allSettled([db?.close(),appDb?.close(),root?.end()]);if(results.some(r=>r.status==='rejected'))fail('TEST_OWN_POOL_CLOSE_FAILED');})();
 const operation=<T>(fn:()=>Promise<T>,needsSource=true):Promise<T>=>{
  if(closed||closing||poolsClosed||cleanup||sourceDisposing||needsSource&&!created||!needsSource&&!created&&!sourceDisposed)return Promise.reject(new SafetyError('TEST_OWN_DATABASE_CLOSED'));
  const job=fn();jobs.add(job);void job.then(()=>jobs.delete(job),()=>jobs.delete(job));return job;
 };
 const close=async()=>{
  if(closed)return;if(cleanup)return cleanup;
  closing=true;
  cleanup=(async()=>{
   await Promise.allSettled([...jobs,...(installing?[installing]:[])]);
   if(!poolsClosed){const results=await Promise.allSettled([closeSourcePools(),...restoredPools.map(p=>p.end())]);if(results.some(r=>r.status==='rejected'))fail('TEST_OWN_POOL_CLOSE_FAILED');poolsClosed=true;}
   for(const restored of restoredNames){const control=new pg.Client(options('postgres'));try{await control.connect();await identity(control,'postgres',system);await control.query(`DROP DATABASE IF EXISTS "${restored}"`);restoredNames.delete(restored);}finally{await control.end().catch(()=>{});}}
   if(created){const control=new pg.Client(options('postgres'));try{await control.connect();await identity(control,'postgres',system);await control.query(`DROP DATABASE IF EXISTS "${name}"`);created=false;}catch(e){throw safe(e,'TEST_OWN_DATABASE_DROP_FAILED');}finally{await control.end().catch(()=>{});}}
   closed=true;
  })();try{await cleanup;}finally{cleanup=null;}
 };
 const source=new pg.Client(options(sourceName));let sourceLock=false;
 try{
  await source.connect();system=await identity(source,sourceName);
  const observedSystem=run(['psql','--host=/var/run/postgresql','--port=5432','--username=oa_migrator','--dbname='+sourceName,'--no-password','--no-psqlrc','--tuples-only','--no-align','--command','SELECT system_identifier::text FROM pg_control_system()']).toString('utf8').trim();
  if(observedSystem!==system)fail('TEST_DOCKER_CLUSTER_MISMATCH');
  await source.query("SELECT pg_advisory_lock_shared(hashtext('open_aider_migrations'))");sourceLock=true;
  const applied=ledger((await source.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows,definitions);
  const archive=run(['pg_dump','--host=/var/run/postgresql','--port=5432','--username=oa_migrator','--dbname='+sourceName,'--no-password','--format=custom','--schema-only']);
  if(archive.length<5||archive.length>maxBytes||archive.subarray(0,5).toString()!=='PGDMP')fail('TEST_SCHEMA_ARCHIVE_REJECTED');
  const listing=run(['pg_restore','--list'],archive).toString('utf8');
  if(/\b(?:TABLE DATA|MATERIALIZED VIEW DATA|SEQUENCE SET|BLOBS?|LARGE OBJECT|DATABASE(?: PROPERTIES)?)\b/i.test(listing.replace(/^;[^\r\n]*/gm,'')))fail('TEST_SCHEMA_DATA_REJECTED');
  schemaOnly(run(['pg_restore','--schema-only','--file=-'],archive).toString('utf8'));
  if(JSON.stringify(applied)!==JSON.stringify(ledger((await source.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows,definitions)))fail('TEST_SOURCE_SCHEMA_CHANGED');
  const control=new pg.Client(options('postgres'));try{await control.connect();await identity(control,'postgres',system);creationAttempted=true;await control.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;}finally{await control.end().catch(()=>{});}
  run(['pg_restore','--host=/var/run/postgresql','--port=5432','--username=oa_migrator','--dbname='+name,'--no-password','--schema-only','--clean','--if-exists','--exit-on-error','--single-transaction'],archive);
  root=new pg.Pool(options(name));db=new Database(url('RUNTIME_DATABASE_URL',name));appDb=new Database(url('DATABASE_URL',name));
  const own=await root.connect();try{await identity(own,name,system);if((await own.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows.length)fail('TEST_SCHEMA_LEDGER_NOT_EMPTY');
   await own.query('BEGIN');try{for(const row of applied)await own.query('INSERT INTO public.schema_migrations(name,hash) VALUES($1,$2)',[row.name,row.hash]);await own.query('COMMIT');}catch(e){await own.query('ROLLBACK');throw e;}
   if(JSON.stringify(applied)!==JSON.stringify(ledger((await own.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows,definitions)))fail('TEST_SCHEMA_COPY_MISMATCH');
  }finally{own.release();}
  const install=async()=>{
   if(closed||closing||poolsClosed||cleanup||!created)fail('TEST_OWN_DATABASE_CLOSED');if(installing)return installing;
   installing=(async()=>{const current=await files(),last=current.at(-1)!;for(const item of current.slice(94))schemaOnly(item.sql);const c=await root!.connect();try{await identity(c,name,system);await c.query('BEGIN');try{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('open_aider_migrations'))");const rows=ledger((await c.query('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows,current);
    for(const item of current.slice(rows.length)){await c.query(item.sql);await c.query('INSERT INTO public.schema_migrations(name,hash) VALUES($1,$2)',[item.name,item.hash]);}
    await c.query('COMMIT');return last.hash;
   }catch(e){await c.query('ROLLBACK');throw e;}}catch(e){throw safe(e,'TEST_OWN_MIGRATION_FAILED');}finally{c.release();}})();try{return await installing;}finally{installing=null;}
  };
  const dumpOwn=()=>operation(async()=>{
   if(closed||poolsClosed||cleanup||!created)fail('TEST_OWN_DATABASE_CLOSED');const c=new pg.Client(options(name));
   try{await c.connect();await identity(c,name,system);await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SELECT pg_advisory_xact_lock_shared(hashtext('open_aider_migrations'))");
    const snapshot=(await c.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot as string;if(!/^[0-9A-F-]{8,80}$/.test(snapshot))fail('TEST_SNAPSHOT_REJECTED');
    const archive=run(['pg_dump','--host=/var/run/postgresql','--port=5432','--username=oa_migrator','--dbname='+name,'--no-password','--format=custom','--snapshot='+snapshot]);
    if(archive.subarray(0,5).toString()!=='PGDMP'||archive.length>maxBytes)fail('TEST_OWN_ARCHIVE_REJECTED');issuedArchives.add(createHash('sha256').update(archive).digest('hex'));await c.query('COMMIT');return archive;
   }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
  });
  const restoreOwn=(archive:Buffer)=>operation(async()=>{
   if(closed||poolsClosed||cleanup||!created&&!sourceDisposed||!Buffer.isBuffer(archive)||archive.length>maxBytes)fail('TEST_OWN_ARCHIVE_REJECTED');const frozen=Buffer.from(archive);
   if(!issuedArchives.has(createHash('sha256').update(frozen).digest('hex'))){frozen.fill(0);fail('TEST_OWN_ARCHIVE_REJECTED');}
   try{
   const restored='open_aider_test_group_reminder_'+randomUUID().replaceAll('-',''),control=new pg.Client(options('postgres'));
   let dispatched=false;
   try{await control.connect();await identity(control,'postgres',system);dispatched=true;await control.query(`CREATE DATABASE "${restored}" TEMPLATE template0`);restoredNames.add(restored);}
   catch(error){const failure=safe(error,'TEST_RESTORE_DATABASE_CREATE_FAILED');if(dispatched){failure.ownDatabaseName=restored;failure.creationState=restoredNames.has(restored)?'CONFIRMED':'UNKNOWN';}throw failure;}
   finally{await control.end();}
   run(['pg_restore','--host=/var/run/postgresql','--port=5432','--username=oa_migrator','--dbname='+restored,'--no-password','--exit-on-error','--single-transaction'],frozen);
   const pool=new pg.Pool(options(restored));restoredPools.push(pool);const c=await pool.connect();try{await identity(c,restored,system);}finally{c.release();}
   return {name:restored,root:pool,connectionString:url('MIGRATION_DATABASE_URL',restored),runtimeConnectionString:url('RUNTIME_DATABASE_URL',restored),appConnectionString:url('DATABASE_URL',restored)};
   }finally{frozen.fill(0);}
  },false);
  // No caller-controlled database identifier or URL: native restore acceptance
  // gets only a fresh, tracked, empty nonce. Existing issued-archive validation
  // in restoreOwn is unchanged. An uncertain CREATE is never retried/dropped.
  const createOwnEmptyRestoreTarget=()=>operation(async()=>{
   if(emptyRestoreTargetsIssued>=4)fail('TEST_EMPTY_RESTORE_LIMIT');emptyRestoreTargetsIssued++;
   const restored='open_aider_test_group_reminder_'+randomUUID().replaceAll('-',''),control=new pg.Client(options('postgres'));let dispatched=false;
   try{await control.connect();await identity(control,'postgres',system);dispatched=true;await control.query(`CREATE DATABASE "${restored}" TEMPLATE template0`);restoredNames.add(restored);}
   catch(error){const failure=safe(error,'TEST_EMPTY_RESTORE_CREATE_FAILED');if(dispatched){failure.ownDatabaseName=restored;failure.creationState=restoredNames.has(restored)?'CONFIRMED':'UNKNOWN';}throw failure;}
   finally{await control.end();}
   const c=new pg.Client(options(restored));let oid:string;
   try{await c.connect();await identity(c,restored,system);oid=(await c.query('SELECT oid::text value FROM pg_database WHERE datname=current_database()')).rows[0].value;}
   finally{await c.end();}
   const pool=new pg.Pool(options(restored));restoredPools.push(pool);
   return {name:restored,root:pool,databaseOid:oid,connectionString:url('MIGRATION_DATABASE_URL',restored),runtimeConnectionString:url('RUNTIME_DATABASE_URL',restored),appConnectionString:url('DATABASE_URL',restored)};
  },false);
  const destroyOwnSource=()=>operation(async()=>{
   if(jobs.size||installing||restoredNames.size)fail('TEST_OWN_DISASTER_REQUIRES_IDLE_SOURCE');sourceDisposing=true;
   await closeSourcePools();const control=new pg.Client(options('postgres'));
   try{await control.connect();await identity(control,'postgres',system);await control.query(`DROP DATABASE "${name}"`);created=false;sourceDisposed=true;sourceDisposing=false;return {name,state:'DESTROYED' as const};}
   catch(error){throw safe(error,'TEST_OWN_SOURCE_DESTRUCTION_UNCERTAIN');}
   finally{await control.end();}
  });
  return {root,db,appDb,name,close,install,dumpOwn,restoreOwn,createOwnEmptyRestoreTarget,destroyOwnSource,connectionString:url('MIGRATION_DATABASE_URL',name)};
 }catch(e){
  const confirmed=created;let error=safe(e,'TEST_DISPOSABLE_SCHEMA_SETUP_FAILED');
  try{await close();}catch{error=new SafetyError('TEST_SETUP_FAILED_OWN_CLEANUP_INCOMPLETE');}
  if(creationAttempted){error.ownDatabaseName=name;error.creationState=confirmed?'CONFIRMED':'UNKNOWN';}
  throw error;
 }
 finally{if(sourceLock)await source.query("SELECT pg_advisory_unlock_shared(hashtext('open_aider_migrations'))").catch(()=>{});await source.end().catch(()=>{});}
}
