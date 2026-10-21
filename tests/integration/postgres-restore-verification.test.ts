import '../support/isolation.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,chmod,realpath,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {writePrivateArchive,openPrivateArchive} from '../../packages/operations/src/archive.js';
import {capturePostgresInventory,comparePostgresInventories,validatePostgresInventory,type PostgresInventory} from '../../packages/operations/src/postgres-inventory.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {groupCaseWorld} from '../support/group-cases.js';
let source:Awaited<ReturnType<typeof groupReminderDatabase>>,w:Awaited<ReturnType<typeof groupCaseWorld>>,directory:string,system:string,before:PostgresInventory,restored:Awaited<ReturnType<typeof source.restoreOwn>>;
const signal=()=>new AbortController().signal,limits={maxTables:512,maxRows:100000,maxBytes:16*1024*1024,timeoutMs:60000},vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
const sentinel='SYNTHETIC_PRIVATE_RESTORE_BODY_不应输出',actionId=randomUUID();
const capture=(connectionString:string,expectedDatabase:string,changes:Record<string,unknown>={})=>capturePostgresInventory({connectionString,expectedDatabase,expectedSystemIdentifier:system,expectedSchemaFingerprint:requiredSchema.contractHash,limits,signal:signal(),...changes});
beforeAll(async()=>{
 source=await groupReminderDatabase();await source.install();w=await groupCaseWorld(source.root,source.db,source.appDb,vault);await w.approve();await w.save();
 await source.root.query("CREATE TABLE public.operations_restore_probe(id int,body jsonb,payload bytea,at timestamptz,dimensions int[],raw_json json); ALTER TABLE public.operations_restore_probe ENABLE ROW LEVEL SECURITY; ALTER TABLE public.operations_restore_probe FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_probe ON public.operations_restore_probe USING (current_setting('app.tenant_id',true) IS NOT NULL); REVOKE ALL ON public.operations_restore_probe FROM PUBLIC; GRANT SELECT ON public.operations_restore_probe TO oa_runtime; CREATE SEQUENCE public.operations_restore_sequence; CREATE VIEW public.operations_restore_view WITH (security_invoker=true) AS SELECT * FROM public.operations_restore_probe; CREATE TABLE public.operations_restore_parent(k int); CREATE TABLE public.operations_restore_child() INHERITS(public.operations_restore_parent); CREATE TABLE public.operations_restore_partitioned(k int) PARTITION BY RANGE(k); CREATE TABLE public.operations_restore_partition PARTITION OF public.operations_restore_partitioned FOR VALUES FROM(0) TO(10)");
 await source.root.query("INSERT INTO public.operations_restore_probe VALUES(1,$1,$2,'2026-10-20T01:00:00Z','[0:1]={1,2}','{\"x\":1,\"x\":2}'),(1,$1,$2,'2026-10-20T01:00:00Z','[0:1]={1,2}','{\"x\":1,\"x\":2}')",[JSON.stringify({body:sentinel}),Buffer.from([0,1,255])]);await source.root.query("SELECT setval('public.operations_restore_sequence',101,true)");
 await source.root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version) VALUES($1,$2,$3,$4,$5,$6,'UNKNOWN','SYNTHETIC_RESTORE','1.0.0')",[w.f.ctx.tenantId,actionId,w.f.ctx.actorId,w.f.runId,randomUUID(),hash(sentinel)]);
 system=(await source.root.query('SELECT system_identifier::text value FROM pg_control_system()')).rows[0].value;
 directory=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-restore-inventory-')));await chmod(directory,0o700);before=await capture(source.connectionString,source.name);
},60000);
afterAll(async()=>{await w?.f.close();await source?.close();if(directory)await rm(directory,{recursive:true,force:true});},60000);
async function cli(args:string[]){return new Promise<{code:number|null;stdout:string;stderr:string;value:Record<string,unknown>}>((resolvePromise,reject)=>{
 const cwd=resolve(import.meta.dirname,'../..'),child=spawn(process.execPath,['--import',join(cwd,'scripts/test-network-guard.mjs'),'--import',join(cwd,'node_modules/tsx/dist/loader.mjs'),join(cwd,'scripts/restore-verification.ts'),...args],{cwd,env:{PATH:process.env['PATH']??'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=String(b);});child.stderr.on('data',b=>{stderr+=String(b);});child.on('error',reject);child.on('close',code=>resolvePromise({code,stdout,stderr,value:JSON.parse(stdout)}));
 });}
it('T124 local precursor: actual PG dump encrypted archive and authenticated staging restore into a new nonce preserve real tasks RLS ACL data and sequence hashes',async()=>{
 const dump=await source.dumpOwn(),backupId=randomUUID(),key=randomBytes(32),metadata={keyId:'SYNTHETIC_SEPARATE_KEY',sourceSchemaFingerprint:requiredSchema.contractHash,type:'POSTGRES_DUMP' as const},receipt=await writePrivateArchive({root:directory,backupId,key,maxBytes:16*1024*1024,signal:signal(),metadata,input:Readable.from([dump])});
 expect(receipt.plaintext.sha256).toBe(createHash('sha256').update(dump).digest('hex'));expect(receipt.archive.sha256).not.toBe(receipt.plaintext.sha256);dump.fill(0);
 const lease=await openPrivateArchive({root:directory,backupId,key,maxBytes:16*1024*1024,signal:signal(),expectedMetadata:metadata});
 try{const bytes=await readFile(lease.plaintextPath);expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.plaintext.sha256);restored=await source.restoreOwn(bytes);bytes.fill(0);}finally{await lease.cleanup();key.fill(0);}
 const after=await capture(restored.connectionString,restored.name);expect(after.database).not.toBe(before.database);expect(comparePostgresInventories(before,after)).toMatchObject({status:'MATCH',schemaMatches:true,metadataMatches:true,dataMatches:true,sequencesMatch:true,externalDispatchResumeAuthorized:false,revocationAndExternalStateReconciliationRequired:true});
 expect(after.tables.find(t=>t.name==='tasks')!.rows).toBeGreaterThan(0);expect(after.tables.find(t=>t.name==='operations_restore_probe')!.rows).toBe(2);
 expect((await restored.root.query('SELECT state FROM tool_actions WHERE id=$1',[actionId])).rows[0].state).toBe('UNKNOWN');expect((await restored.root.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.operations_restore_probe'::regclass")).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});
 expect(JSON.stringify(before)).not.toContain(sentinel);expect((await capture(source.connectionString,source.name)).contentFingerprint).toBe(before.contentFingerprint);
},60000);
it('an issued archive is frozen before the first restore await, so caller mutation cannot replace pg_restore bytes',async()=>{
 const dump=await source.dumpOwn(),pending=source.restoreOwn(dump);dump.fill(0);const copied=await pending;expect(comparePostgresInventories(before,await capture(copied.connectionString,copied.name)).status).toBe('MATCH');
},60000);
it('capture and compare actual CLI use private profiles sanitized environment and disclose hashes only',async()=>{
 const connection=join(directory,'connection.txt'),profile=join(directory,'profile.json'),output=join(directory,'inventory.json');await writeFile(connection,source.connectionString,{mode:0o600});await writeFile(profile,JSON.stringify({schemaVersion:1,kind:'POSTGRES_READ_ONLY_RESTORE_VERIFICATION',connectionFile:connection,expectedDatabase:source.name,expectedSystemIdentifier:system,expectedSchemaFingerprint:requiredSchema.contractHash,limits}),{mode:0o600});
 const result=await cli(['capture','--profile',profile,'--output',output]);expect(result.code).toBe(0);expect(result.value).toMatchObject({status:'CAPTURED_READ_ONLY',contentFingerprint:before.contentFingerprint,externalDispatchResumeAuthorized:false});expect(result.stdout+result.stderr).not.toContain(sentinel);expect(result.stdout+result.stderr).not.toContain(source.connectionString);expect((await stat(output)).mode&0o777).toBe(0o600);
 const compared=await cli(['compare','--before',output,'--after',output]);expect(compared.code).toBe(0);expect(compared.value.status).toBe('MATCH');
 const duplicate=await cli(['capture','--profile',profile,'--output',output]);expect(duplicate.code).toBe(1);expect(duplicate.value.status).toBe('REJECTED');expect(validatePostgresInventory(JSON.parse(await readFile(output,'utf8'))).contentFingerprint).toBe(before.contentFingerprint);
},60000);
it.each(['data','rls','acl','column-acl','view-options','array-bounds','raw-json','inheritance','partition','policy','sequence','function'] as const)('a restored %s drift is reported and never authorizes external replay',async kind=>{
 expect(restored).toBeDefined();const c=await restored.root.connect();await c.query('BEGIN');
 try{
  const sql={data:"DELETE FROM public.operations_restore_probe WHERE ctid IN (SELECT ctid FROM public.operations_restore_probe LIMIT 1)",rls:'ALTER TABLE public.operations_restore_probe NO FORCE ROW LEVEL SECURITY',acl:'REVOKE SELECT ON public.operations_restore_probe FROM oa_runtime','column-acl':'GRANT UPDATE(body) ON public.operations_restore_probe TO oa_runtime','view-options':'ALTER VIEW public.operations_restore_view SET (security_invoker=false)','array-bounds':"UPDATE public.operations_restore_probe SET dimensions=ARRAY[1,2]",'raw-json':"UPDATE public.operations_restore_probe SET raw_json='{\"x\":2}'",inheritance:'ALTER TABLE public.operations_restore_child NO INHERIT public.operations_restore_parent',partition:'ALTER TABLE public.operations_restore_partitioned DETACH PARTITION public.operations_restore_partition',policy:'ALTER POLICY tenant_probe ON public.operations_restore_probe USING (false)',sequence:"SELECT setval('public.operations_restore_sequence',202,true)",function:"CREATE FUNCTION public.operations_restore_unreviewed() RETURNS int LANGUAGE sql AS 'SELECT 1'"}[kind];
  // Capture owns another repeatable-read connection, so commit this deliberate
  // isolated corruption; each case restores its exact previous state below.
  await c.query(sql);await c.query('COMMIT');const observed=await capture(restored.connectionString,restored.name),comparison=comparePostgresInventories(before,observed);expect(comparison.status).toBe('DIFFERENT');expect(comparison.externalDispatchResumeAuthorized).toBe(false);
 }finally{
  await c.query('ROLLBACK');const repair={data:"INSERT INTO public.operations_restore_probe SELECT * FROM public.operations_restore_probe LIMIT 1",rls:'ALTER TABLE public.operations_restore_probe FORCE ROW LEVEL SECURITY',acl:'GRANT SELECT ON public.operations_restore_probe TO oa_runtime','column-acl':'REVOKE UPDATE(body) ON public.operations_restore_probe FROM oa_runtime','view-options':'ALTER VIEW public.operations_restore_view SET (security_invoker=true)','array-bounds':"UPDATE public.operations_restore_probe SET dimensions='[0:1]={1,2}'",'raw-json':"UPDATE public.operations_restore_probe SET raw_json='{\"x\":1,\"x\":2}'",inheritance:'ALTER TABLE public.operations_restore_child INHERIT public.operations_restore_parent',partition:'ALTER TABLE public.operations_restore_partitioned ATTACH PARTITION public.operations_restore_partition FOR VALUES FROM(0) TO(10)',policy:"ALTER POLICY tenant_probe ON public.operations_restore_probe USING (current_setting('app.tenant_id',true) IS NOT NULL)",sequence:"SELECT setval('public.operations_restore_sequence',101,true)",function:'DROP FUNCTION public.operations_restore_unreviewed()'}[kind];await c.query(repair);c.release();
 }
},60000);
it.each(['database','system','schema','role','cancel','rows','bytes','tables'] as const)('capture rejects %s mismatch with a fixed error and zero mutation',async kind=>{
 const controller=new AbortController();controller.abort();let url=source.connectionString;if(kind==='role'){const parsed=new URL(url);parsed.username='oa_runtime';url=parsed.href;}
 const changes={database:{expectedDatabase:'wrong_synthetic_database'},system:{expectedSystemIdentifier:'0'},schema:{expectedSchemaFingerprint:'0'.repeat(64)},role:{},cancel:{signal:controller.signal},rows:{limits:{...limits,maxRows:1}},bytes:{limits:{...limits,maxBytes:1}},tables:{limits:{...limits,maxTables:1}}}[kind];
 await expect(capture(url,source.name,changes)).rejects.toMatchObject({code:{database:'INVALID_INPUT',system:'IDENTITY_MISMATCH',schema:'SCHEMA_MISMATCH',role:'INVALID_INPUT',cancel:'CANCELLED',rows:'LIMIT_EXCEEDED',bytes:'LIMIT_EXCEEDED',tables:'LIMIT_EXCEEDED'}[kind]});
 expect((await source.root.query('SELECT count(*)::int n FROM public.operations_restore_probe')).rows[0].n).toBe(2);
},60000);
it('an unissued or altered archive cannot create a restoration database',async()=>{await expect(source.restoreOwn(Buffer.from('PGDMP synthetic-unissued'))).rejects.toThrow('TEST_OWN_ARCHIVE_REJECTED');});

it('closing during a pending restore waits for its registered work and removes only its confirmed own databases',async()=>{
 const extra=await groupReminderDatabase();await extra.install();let copied:Awaited<ReturnType<typeof extra.restoreOwn>>|undefined;
 try{const archive=await extra.dumpOwn(),pending=extra.restoreOwn(archive),closing=extra.close();copied=await pending;await closing;expect(copied.root.ended).toBe(true);expect(extra.root.ended).toBe(true);expect((await source.root.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[[extra.name,copied.name]])).rows).toEqual([]);await expect(extra.dumpOwn()).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');}
 finally{await extra.close();}
},60000);

it.each(['cancel','timeout'] as const)('an actual blocked read ends on %s and returns no inventory or authority to resume',async kind=>{
 const row=(await source.root.query("SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','m') ORDER BY n.nspname COLLATE \"C\",c.relname COLLATE \"C\" LIMIT 1")).rows[0],quote=(v:string)=>'"'+v.replaceAll('"','""')+'"',lock=await source.root.connect(),controller=new AbortController();
 await lock.query('BEGIN');await lock.query(`LOCK TABLE ${quote(row.schema)}.${quote(row.name)} IN ACCESS EXCLUSIVE MODE`);
 try{
  const pending=capture(source.connectionString,source.name,{signal:controller.signal,limits:{...limits,timeoutMs:kind==='timeout'?1000:10000}});void pending.catch(()=>{});
  if(kind==='cancel'){let waiting=false;for(let i=0;i<200;i++){waiting=!!(await source.root.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name='anthys-restore-verification' AND wait_event_type='Lock'",[source.name])).rowCount;if(waiting)break;await new Promise(resolvePromise=>setTimeout(resolvePromise,20));}expect(waiting).toBe(true);controller.abort();}
  await expect(pending).rejects.toMatchObject({code:kind==='timeout'?'TIMEOUT':'CANCELLED'});
 }finally{await lock.query('ROLLBACK');lock.release();}
},15000);
