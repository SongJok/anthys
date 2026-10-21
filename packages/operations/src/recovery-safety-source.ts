import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {z} from 'zod';
import {requiredSchema} from '../../storage/src/schema.js';

// A cold, explicitly fenced source only. This is neither a continuously current
// disaster journal nor authorization to resume a restored application.
// Every row of each listed projection is captured; no WHERE filter or tenant
// supplied by a browser can turn absence into a claim of completeness.
const projections=[
 ['tenants',"jsonb_build_object('tenant_id',t.tenant_id,'status',t.status,'policy_version',t.policy_version)"],
 ['users',"jsonb_build_object('tenant_id',t.tenant_id,'id',t.id,'status',t.status,'auth_epoch',t.auth_epoch)"],
 ['resource_grants','to_jsonb(t)'],['role_bindings','to_jsonb(t)'],
 ['dws_identities',"to_jsonb(t)-'credentials_ref'"],
 ['memory_scope_epochs','to_jsonb(t)'],['memory_deletions','to_jsonb(t)'],
 ['persona_privacy_state','to_jsonb(t)'],['persona_privacy_erasures','to_jsonb(t)'],
 ['one_shot_trials','to_jsonb(t)'],
 ['tool_actions',"to_jsonb(t)-ARRAY['input_ref','result']"],
 ['quota_ledger',"to_jsonb(t)-ARRAY['provider_usage','policy_snapshot']"],
 ['budget_buckets','to_jsonb(t)'],['budget_allocations','to_jsonb(t)'],
 ['formal_authorizations',"to_jsonb(t)-'profile_document'"],
] as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/),oid=z.string().regex(/^[1-9][0-9]{0,9}$/);
const inputSchema=z.strictObject({connectionString:z.string().min(1).max(8192),expectedDatabase:z.string().min(1).max(63),expectedDatabaseOid:oid,expectedSystemIdentifier:z.string().regex(/^[0-9]{1,24}$/),expectedSchemaFingerprint:sha,timeoutMs:z.number().int().min(1000).max(60000),maxRows:z.number().int().min(1).max(100000),maxBytes:z.number().int().min(1024).max(3*1024*1024)});
export type RecoverySafetySourceInput=z.infer<typeof inputSchema>&{signal:AbortSignal};
export const recoverySafetyProjectionScope=Object.freeze({version:1,kind:'COLD_FENCED_DATABASE_SAFETY_PROJECTION' as const,tables:Object.freeze(projections.map(([table,expression])=>Object.freeze({table,expression}))),coverage:'EVERY_ROW_OF_FIXED_PROJECTIONS' as const,continuousDisasterJournal:false as const});
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
export const recoverySafetyProjectionHash=digest(JSON.stringify(recoverySafetyProjectionScope));
export class RecoverySafetySourceError extends Error{
 constructor(readonly code:string,readonly sourceFenceMayBeActive:boolean){super(code);}
}
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';

/** Explicit operator boundary: ALLOW_CONNECTIONS=false persists even on failure.
 * The caller must have specific maintenance permission, separate retained
 * authority storage and an invalidation-before-reopen protocol. Never called by
 * API startup, a scheduler, a model, restore verification or an ordinary read.
 * A later signed envelope alone cannot make this snapshot current after reopen.
 */
export async function freezeRecoverySafetySource(raw:RecoverySafetySourceInput){
 const {signal:callerSignal,...candidate}=raw,p=inputSchema.safeParse(candidate);
 if(!p.success||!(callerSignal instanceof AbortSignal))throw new RecoverySafetySourceError('RECOVERY_SOURCE_INPUT_INVALID',false);
 const input=p.data;let url:URL;
 try{url=new URL(input.connectionString);if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||!['64710','64711'].includes(url.port)||url.username!=='oa_migrator'||!url.password||decodeURIComponent(url.pathname.slice(1))!==input.expectedDatabase||url.search||url.hash||['postgres','template0','template1'].includes(input.expectedDatabase))throw Error();}catch{throw new RecoverySafetySourceError('RECOVERY_SOURCE_INPUT_INVALID',false);}
 const started=performance.now(),deadline=started+input.timeoutMs,controller=new AbortController(),signal=AbortSignal.any([callerSignal,controller.signal]),timer=setTimeout(()=>controller.abort(),input.timeoutMs),socket=new Socket();
 let fenceAttempted=false,connected=false,transaction=false,committed=false,closed=false;
 const socketClosed=new Promise<void>(resolve=>socket.once('close',()=>{closed=true;resolve();}));socket.on('error',()=>{});
 const c=new pg.Client({host:'127.0.0.1',port:Number(url.port),database:input.expectedDatabase,user:'oa_migrator',password:decodeURIComponent(url.password),ssl:false,client_encoding:'UTF8',options:'-c row_security=off',connectionTimeoutMillis:Math.min(3000,input.timeoutMs),query_timeout:input.timeoutMs,application_name:'anthys-fenced-safety-source',stream:()=>socket});
 c.on('error',()=>{});const stop=()=>socket.destroy();signal.addEventListener('abort',stop,{once:true});
 const check=()=>{if(signal.aborted||performance.now()>=deadline)throw new RecoverySafetySourceError(callerSignal.aborted?'RECOVERY_SOURCE_CANCELLED':'RECOVERY_SOURCE_TIMEOUT',fenceAttempted);};
 const query=async<T extends pg.QueryResultRow=pg.QueryResultRow>(text:string,values?:unknown[])=>{check();const result=await c.query<T>(text,values);check();return result;};
 try{
  check();await c.connect();connected=true;check();
  await query("SET search_path=pg_catalog; SET timezone='UTC'; SET DateStyle='ISO, YMD'; SET extra_float_digits=3; SET row_security=off");
  await query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$1,false)",[String(Math.min(input.timeoutMs,3000))]);
  const identity=(await query("SELECT current_database() database,current_user role,(SELECT oid::text FROM pg_database WHERE datname=current_database()) oid,(SELECT system_identifier::text FROM pg_control_system()) system,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser,current_setting('server_version_num')::int version")).rows[0];
  if(!identity||identity.database!==input.expectedDatabase||identity.role!=='oa_migrator'||identity.oid!==input.expectedDatabaseOid||identity.system!==input.expectedSystemIdentifier||identity.superuser!==true||identity.version<170000||identity.version>179999)throw new RecoverySafetySourceError('RECOVERY_SOURCE_IDENTITY_MISMATCH',false);
  const ledger=(await query<{name:string;hash:string}>('SELECT name,hash FROM public.schema_migrations ORDER BY name COLLATE "C"')).rows;
  if(ledger.length<73||ledger.length>requiredSchema.migrations.length||ledger.some((r,i)=>r.name!==requiredSchema.migrations[i]?.name||r.hash!==requiredSchema.migrations[i]?.hash)||digest(ledger.map(r=>r.name+'\0'+r.hash+'\0').join(''))!==input.expectedSchemaFingerprint||(await query('SELECT public.oa_schema_ledger_read_only() safe')).rows[0]?.safe!==true)throw new RecoverySafetySourceError('RECOVERY_SOURCE_SCHEMA_MISMATCH',false);
  const unsupported=(await query('SELECT EXISTS(SELECT 1 FROM pg_subscription) OR EXISTS(SELECT 1 FROM pg_foreign_table) OR EXISTS(SELECT 1 FROM pg_prepared_xacts WHERE database=current_database()) found')).rows[0]?.found;
  if(unsupported!==false)throw new RecoverySafetySourceError('RECOVERY_SOURCE_UNSUPPORTED_WRITERS',false);
  // A failed acknowledgement may still have committed the persistent fence.
  // Never compensate by reopening; reconcile through the retained authority.
  fenceAttempted=true;await query('ALTER DATABASE '+quote(input.expectedDatabase)+' ALLOW_CONNECTIONS false');
  await query('SELECT pg_stat_clear_snapshot()');
  const others=(await query('SELECT pid FROM pg_stat_activity WHERE datid=$1::oid AND pid<>pg_backend_pid() ORDER BY pid',[input.expectedDatabaseOid])).rows;
  if(others.length>1000)throw new RecoverySafetySourceError('RECOVERY_SOURCE_TOO_MANY_BACKENDS',true);
  for(const row of others){if((await query('SELECT pg_terminate_backend($1,1000) stopped',[row.pid])).rows[0]?.stopped!==true)throw new RecoverySafetySourceError('RECOVERY_SOURCE_BACKEND_NOT_STOPPED',true);}
  const assertFence=async()=>{
   await query('SELECT pg_stat_clear_snapshot()');
   const observed=(await query('SELECT d.datallowconn allowed,(SELECT count(*)::int FROM pg_stat_activity WHERE datid=d.oid AND pid<>pg_backend_pid()) backends,(SELECT count(*)::int FROM pg_prepared_xacts WHERE database=d.datname) prepared FROM pg_database d WHERE d.oid=$1::oid',[input.expectedDatabaseOid])).rows[0];
   if(!observed||observed.allowed!==false||observed.backends!==0||observed.prepared!==0)throw new RecoverySafetySourceError('RECOVERY_SOURCE_FENCE_NOT_CONFIRMED',true);
  };
  await assertFence();await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
  const tables:Array<{table:string;rows:string[];sha256:string}>=[];let bytes=0,rows=0;
  for(const [table,expression] of projections){
   await query('DECLARE oa_safety_rows NO SCROLL CURSOR FOR SELECT octet_length(v) size,CASE WHEN octet_length(v)<=$1 THEN v ELSE NULL END value FROM (SELECT ('+expression+')::text v FROM public.'+quote(table)+' t) projected ORDER BY v COLLATE "C"',[input.maxBytes]);
   const records:string[]=[];
   for(;;){const page=(await query('FETCH FORWARD 100 FROM oa_safety_rows')).rows;if(!page.length)break;for(const row of page){rows++;bytes+=Number(row.size);if(typeof row.value!=='string'||rows>input.maxRows||bytes>input.maxBytes)throw new RecoverySafetySourceError('RECOVERY_SOURCE_CAPTURE_LIMIT',true);records.push(row.value);}}
   await query('CLOSE oa_safety_rows');tables.push({table,rows:records,sha256:digest(JSON.stringify(records))});
  }
  await assertFence();const stamp=z.date().parse((await query('SELECT clock_timestamp() stamp')).rows[0]?.stamp),capturedAt=stamp.toISOString();
  const facts={schemaVersion:1 as const,source:{database:input.expectedDatabase,databaseOid:input.expectedDatabaseOid,systemIdentifier:input.expectedSystemIdentifier,schemaFingerprint:input.expectedSchemaFingerprint,migrationCount:ledger.length},projectionHash:recoverySafetyProjectionHash,capturedAt,tables};
  const encoded=JSON.stringify(facts);if(Buffer.byteLength(encoded)>input.maxBytes)throw new RecoverySafetySourceError('RECOVERY_SOURCE_CAPTURE_LIMIT',true);
  await query('COMMIT');transaction=false;committed=true;await assertFence();
  return {facts,factsHash:digest(encoded),fence:{kind:'PG_NO_CONNECTIONS_SINGLE_BACKEND_V1' as const,allowConnections:false as const,otherBackends:0 as const,preparedTransactions:0 as const},scope:recoverySafetyProjectionScope,sourceFenceMayBeActive:true as const,sourceReopenAuthorized:false as const,externalDispatchResumeAuthorized:false as const,independentRetentionVerified:false as const};
 }catch(error){
  if(transaction&&!signal.aborted)await c.query('ROLLBACK').catch(()=>{});
  if(error instanceof RecoverySafetySourceError)throw error;
  throw new RecoverySafetySourceError(signal.aborted?(callerSignal.aborted?'RECOVERY_SOURCE_CANCELLED':'RECOVERY_SOURCE_TIMEOUT'):'RECOVERY_SOURCE_CAPTURE_FAILED',fenceAttempted);
 }finally{
  // The lifetime also includes normal end. Own only this socket, and bound the
  // observation of cleanup; never retry ALTER DATABASE or undo an unknown fence.
  const ending=c.end().then(()=>true,()=>false);let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
  const ended=await Promise.race([ending,new Promise<false>(resolve=>{cleanupTimer=setTimeout(()=>{socket.destroy();resolve(false);},1000);})]);clearTimeout(cleanupTimer);
  if(!socket.destroyed)socket.destroy();if(connected&&!closed)await Promise.race([socketClosed,new Promise<void>(resolve=>setTimeout(resolve,1000))]);
  clearTimeout(timer);signal.removeEventListener('abort',stop);
  if(committed&&(!ended||!closed||signal.aborted||performance.now()>=deadline))throw new RecoverySafetySourceError('RECOVERY_SOURCE_CLEANUP_UNCONFIRMED',fenceAttempted);
 }
}
