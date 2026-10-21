import pg from 'pg';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {open,readdir,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {Socket} from 'node:net';
import {join,isAbsolute} from 'node:path';
import {requiredSchema} from '../../storage/src/schema.js';
import {readOperationsPrivateFile} from './private-file.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/),reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/);
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const prefix=(count:number)=>digest(requiredSchema.migrations.slice(0,count).map(m=>m.name+'\0'+m.hash+'\0').join(''));
/** A separately reviewed maintenance step, never an application startup option.
 * References are operator attestations, not machine proof of a backup/approval. */
export const boundedMigrationProfile=z.object({
 schemaVersion:z.literal(1),kind:z.literal('BOUNDED_PROJECT_MIGRATION_STEP'),reviewReference:reference,
 repository:z.string().min(1),connectionFile:z.string().min(1),connectionFileSha256:sha,
 target:z.object({host:z.literal('127.0.0.1'),port:z.number().int().min(1).max(65535),database:z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),systemIdentifierSha256:sha}).strict(),
 from:z.number().int().min(73).max(998),to:z.number().int().min(74).max(999),sourceFingerprint:sha,targetFingerprint:sha,repositoryContractFingerprint:sha,
 validFrom:z.iso.datetime(),validUntil:z.iso.datetime(),maxDurationMs:z.number().int().min(1000).max(60000),lockTimeoutMs:z.number().int().min(1).max(5000),
 prerequisites:z.object({maintenanceStopReference:reference,backupReference:reference,restoredPostgresContentFingerprint:sha,restoredFileStoreManifestSha256:sha,keyRecoveryReference:reference,sqlSemanticReviewSha256:sha,externalStateReconciliationReference:reference}).strict(),
}).strict().superRefine((p,c)=>{if(p.to!==p.from+1||p.to>requiredSchema.migrations.length||p.sourceFingerprint!==prefix(p.from)||p.targetFingerprint!==prefix(p.to)||p.repositoryContractFingerprint!==requiredSchema.contractHash||Date.parse(p.validUntil)<=Date.parse(p.validFrom)||Date.parse(p.validUntil)-Date.parse(p.validFrom)>600000)c.addIssue({code:'custom',message:'BOUNDED_MIGRATION_EXACT_STEP_REQUIRED'});});
export type BoundedMigrationProfile=z.infer<typeof boundedMigrationProfile>;
class MigrationStepFailure extends Error{constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new MigrationStepFailure(code);};
function parseProfile(raw:unknown):BoundedMigrationProfile{try{return boundedMigrationProfile.parse(raw);}catch{return fail('PROFILE_OR_INPUT_REJECTED');}}
function migrationLifetime(p:BoundedMigrationProfile,parent:AbortSignal|undefined,execution:boolean){
 if(parent?.aborted)fail('CANCELLED_OR_TIMEOUT');
 const started=performance.now(),duration=execution?Math.max(0,Math.min(p.maxDurationMs,Date.parse(p.validUntil)-Date.now())):p.maxDurationMs,deadline=started+duration;
 const controller=new AbortController(),signal=parent?AbortSignal.any([parent,controller.signal]):controller.signal,timer=setTimeout(()=>controller.abort(),duration);timer.unref();
 const overrun=()=>performance.now()>=deadline||execution&&Date.now()>=Date.parse(p.validUntil);
 const checkpoint=()=>{if(parent?.aborted)fail('CANCELLED_OR_TIMEOUT');if(execution&&(Date.now()<Date.parse(p.validFrom)||Date.now()>=Date.parse(p.validUntil))){controller.abort();fail('REVIEW_WINDOW_EXPIRED');}if(performance.now()>=deadline){controller.abort();fail('STEP_DEADLINE_EXCEEDED');}if(signal.aborted)fail('CANCELLED_OR_TIMEOUT');};
 return {signal,checkpoint,overrun,abort:()=>controller.abort(),remaining:()=>{checkpoint();return Math.max(1,Math.floor(deadline-performance.now()));},keepAlive:()=>timer.ref(),dispose:()=>clearTimeout(timer)};
}
type MigrationLifetime=ReturnType<typeof migrationLifetime>;
async function sqlBytes(path:string,lifetime:MigrationLifetime){
 lifetime.checkpoint();const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{lifetime.checkpoint();const before=await f.stat();lifetime.checkpoint();if(!before.isFile()||before.size<1||before.size>4*1024*1024)fail('SQL_FILE_REJECTED');const bytes=await f.readFile({signal:lifetime.signal});lifetime.checkpoint();const after=await f.stat();lifetime.checkpoint();if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('SQL_FILE_CHANGED');return bytes;}finally{await f.close();}
}
async function prepareBoundedMigrationStep(p:BoundedMigrationProfile,lifetime:MigrationLifetime){
 lifetime.checkpoint();const profileHash=digest(JSON.stringify(p));
 if(!isAbsolute(p.repository)||await realpath(p.repository)!==p.repository)fail('REPOSITORY_REJECTED');lifetime.checkpoint();
 const names=(await readdir(join(p.repository,'db/migrations'))).filter(n=>n.endsWith('.sql')).sort();lifetime.checkpoint();if(JSON.stringify(names)!==JSON.stringify(requiredSchema.migrations.map(m=>m.name)))fail('REPOSITORY_MIGRATION_SET_CHANGED');
 const contract=JSON.parse((await sqlBytes(join(p.repository,'packages/storage/src/required-migrations.json'),lifetime)).toString('utf8'));lifetime.checkpoint();if(JSON.stringify(contract)!==JSON.stringify(requiredSchema))fail('REPOSITORY_CONTRACT_CHANGED');
 let selected:Buffer|undefined,total=0;
 try{for(const [index,m] of requiredSchema.migrations.entries()){lifetime.checkpoint();const bytes=await sqlBytes(join(p.repository,'db/migrations',m.name),lifetime);lifetime.checkpoint();total+=bytes.length;if(total>64*1024*1024||digest(bytes)!==m.hash)fail('REPOSITORY_SQL_CHANGED');if(index===p.from)selected=bytes;}lifetime.checkpoint();}catch(error){selected?.fill(0);throw error;}
 return {profile:p,profileHash,sql:selected!,migration:requiredSchema.migrations[p.from]!,summary:{status:'PLAN_ONLY_NOT_AUTHORIZED',profileHash,from:p.from,to:p.to,migration:requiredSchema.migrations[p.from]!.name,sqlSha256:requiredSchema.migrations[p.from]!.hash,sourceFingerprint:p.sourceFingerprint,targetFingerprint:p.targetFingerprint,operatorAttestationsOnly:true,prerequisitesIndependentlyVerified:false,databaseAccess:false,credentialsRead:false,servicesStarted:false,automaticContinuation:false,automaticRollbackSql:false,externalDispatchResumeAuthorized:false}};
}
export async function planBoundedMigrationStep(raw:unknown,parent?:AbortSignal){
 if(parent?.aborted)fail('CANCELLED_OR_TIMEOUT');const p=parseProfile(raw),lifetime=migrationLifetime(p,parent,false);
 try{const plan=await prepareBoundedMigrationStep(p,lifetime);lifetime.checkpoint();return plan;}
 catch(error){lifetime.checkpoint();throw error instanceof MigrationStepFailure?error:new MigrationStepFailure('PROFILE_OR_INPUT_REJECTED');}
 finally{lifetime.dispose();}
}
async function ledger(c:pg.Client,count:number){const rows=(await c.query<{name:string;hash:string}>('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows;if(rows.length!==count||rows.some((r,i)=>r.name!==requiredSchema.migrations[i]?.name||r.hash!==requiredSchema.migrations[i]?.hash))fail('DATABASE_LEDGER_CHANGED');}
async function stopped(c:pg.Client){
 const q=await c.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename IN ('oa_app','oa_runtime','oa_queue')) OR EXISTS(SELECT 1 FROM public.runs WHERE status IN ('RUNNING','WAITING_EXTERNAL')) OR EXISTS(SELECT 1 FROM public.tool_actions WHERE state='EXECUTING') OR EXISTS(SELECT 1 FROM public.deliveries WHERE state='SENDING') busy");
 if(q.rows[0]?.busy!==false)fail('DISPATCHERS_OR_IN_FLIGHT_WORK_PRESENT');
}
async function preservation(c:pg.Client){
 // Digest inside PostgreSQL. No trial/admission/mutating authority function,
 // original body, credential, identity or raw business row is returned.
 const projections=[
  "SELECT to_jsonb(t) value FROM public.one_shot_trials t WHERE state='CLOSED' ORDER BY tenant_id",
  "SELECT to_jsonb(a) value FROM public.tool_actions a WHERE state='UNKNOWN' ORDER BY tenant_id,id",
  "SELECT to_jsonb(d) value FROM public.deliveries d WHERE state='UNKNOWN' ORDER BY tenant_id,id",
  "SELECT to_jsonb(a) value FROM public.formal_authorizations a WHERE state='REVOKED' ORDER BY tenant_id,id",
  "SELECT jsonb_build_array(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,revoked_at,expires_at) value FROM public.resource_grants WHERE revoked_at IS NOT NULL ORDER BY tenant_id,id",
  "SELECT jsonb_build_array(tenant_id,id,subject_id,role_id,scope_kind,scope_id,revoked_at,expires_at,version) value FROM public.role_bindings WHERE revoked_at IS NOT NULL ORDER BY tenant_id,id",
  "SELECT jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig) value FROM pg_roles ORDER BY rolname",
 ];
 projections.push("SELECT jsonb_build_array(pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option) value FROM pg_auth_members ORDER BY roleid,member,grantor");
 const hashes:string[]=[];for(const sql of projections){const row=(await c.query("SELECT encode(sha256(convert_to(coalesce(jsonb_agg(value)::text,'[]'),'UTF8')),'hex') hash FROM ("+sql+") observed")).rows[0];hashes.push(row.hash as string);}return digest(JSON.stringify(hashes));
}
function settledBeforeAbort(pending:Promise<boolean>,signal:AbortSignal):Promise<boolean>{return new Promise(resolve=>{
 let done=false;const finish=(value:boolean)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);resolve(value);},abort=()=>finish(false);
 signal.addEventListener('abort',abort,{once:true});pending.then(finish,()=>finish(false));if(signal.aborted)abort();
});}
function settledDuringCleanup(pending:Promise<boolean>):Promise<boolean>{return new Promise(resolve=>{
 let done=false;const timer=setTimeout(()=>finish(false),1000),finish=(value:boolean)=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
 pending.then(finish,()=>finish(false));
});}
type MigrationOutcome={status:'STEP_COMMITTED'|'UNKNOWN'|'REJECTED_ROLLED_BACK_OR_NOT_STARTED';profileHash:string;from:number;to:number;migration:string;sqlSha256?:string;preservationFingerprint?:string;code?:string;sqlState?:string|null;automaticContinuation:false;automaticRollbackSql:false;servicesStarted:false;externalDispatchResumeAuthorized:false};
/** One work budget includes repository/credential preparation. Expiry destroys
 * this operation's own socket; a separate bounded 1s cleanup grace can only
 * confirm closure, never execute/retry SQL or change an acknowledged COMMIT. */
export async function applyBoundedMigrationStep(raw:unknown,review:{profileHash:string;reviewReference:string},parent:AbortSignal){
 if(parent.aborted)fail('CANCELLED_OR_TIMEOUT');const p=parseProfile(raw),profileHash=digest(JSON.stringify(p));
 if(review.profileHash!==profileHash||review.reviewReference!==p.reviewReference)fail('EXACT_REVIEW_REQUIRED');
 const base={profileHash,from:p.from,to:p.to,migration:requiredSchema.migrations[p.from]!.name,automaticContinuation:false,automaticRollbackSql:false,servicesStarted:false,externalDispatchResumeAuthorized:false} as const;
 if(Date.now()<Date.parse(p.validFrom)||Date.now()>=Date.parse(p.validUntil))return {...base,status:'REJECTED_ROLLED_BACK_OR_NOT_STARTED' as const,code:'REVIEW_WINDOW_EXPIRED',sqlState:null,cleanupOutcome:'NOT_STARTED' as const,deadlineOverrunObserved:false};
 const lifetime=migrationLifetime(p,parent,true),signal=lifetime.signal,checkpoint=lifetime.checkpoint;
 let plan:Awaited<ReturnType<typeof prepareBoundedMigrationStep>>|undefined,bytes:Buffer|undefined,client:pg.Client|undefined,socket:Socket|undefined,ending:Promise<boolean>|undefined;
 let socketClosed=false,closed:Promise<void>|undefined,connected=false,commitStarted=false,committed=false,outcome:MigrationOutcome|undefined,cleanupOutcome:'NOT_STARTED'|'CONFIRMED'|'UNCONFIRMED'='NOT_STARTED';
 const end=()=>{if(!client)return Promise.resolve(true);return ending??=Promise.resolve().then(()=>client!.end()).then(()=>true,()=>false);};
 const stop=()=>{socket?.destroy();void end();};
 try{
  checkpoint();plan=await prepareBoundedMigrationStep(p,lifetime);checkpoint();
  bytes=await readOperationsPrivateFile(p.connectionFile,8192).catch(()=>fail('CONNECTION_UNREADABLE'));checkpoint();if(digest(bytes)!==p.connectionFileSha256)fail('CONNECTION_CHANGED');
  let url:URL;const text=bytes.toString('utf8').trim();try{url=new URL(text);if(url.protocol!=='postgresql:'||url.hostname!==p.target.host||(url.port||'5432')!==String(p.target.port)||decodeURIComponent(url.pathname.slice(1))!==p.target.database||url.username!=='oa_migrator'||!url.password||url.search||url.hash||text.includes('?')||text.includes('#'))throw Error();}catch{fail('TARGET_CHANGED');}checkpoint();
  const ownSocket=socket=new Socket();ownSocket.on('error',()=>{});closed=new Promise(resolve=>ownSocket.once('close',()=>{socketClosed=true;resolve();}));
  const c=client=new pg.Client({connectionString:text,connectionTimeoutMillis:Math.min(3000,lifetime.remaining()),query_timeout:lifetime.remaining(),application_name:'anthys-bounded-migration-step',ssl:false,options:'-c search_path=public',stream:()=>ownSocket});
  c.on('error',()=>{});signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  try{
  checkpoint();await c.connect();connected=true;await c.query('BEGIN');await c.query("SELECT set_config('search_path','public',true),set_config('timezone','UTC',true),set_config('row_security','off',true),set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",[String(lifetime.remaining()),String(Math.min(p.lockTimeoutMs,lifetime.remaining()))]);
  await c.query("SELECT pg_advisory_xact_lock(hashtext('anthys_migrations'))");
  const identity=(await c.query("SELECT current_database() database,current_user role,current_setting('server_version_num')::int version,(SELECT system_identifier::text FROM pg_control_system()) system,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) bypass")).rows[0];if(identity.database!==p.target.database||identity.role!=='oa_migrator'||identity.bypass!==true||Math.floor(identity.version/10000)!==17||digest(identity.system)!==p.target.systemIdentifierSha256)fail('DATABASE_IDENTITY_CHANGED');
  if((await c.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('oa_app','oa_runtime','oa_queue') AND has_schema_privilege(oid,'public','CREATE')) unsafe")).rows[0]?.unsafe!==false)fail('PUBLIC_SCHEMA_AUTHORITY_UNSAFE');
  const databaseWindow=async()=>{if((await c.query('SELECT clock_timestamp()>=$1::timestamptz AND clock_timestamp()<$2::timestamptz allowed',[p.validFrom,p.validUntil])).rows[0]?.allowed!==true)fail('DATABASE_REVIEW_WINDOW_EXPIRED');};
  await databaseWindow();if((await c.query('SELECT public.oa_schema_ledger_read_only() safe')).rows[0]?.safe!==true)fail('SCHEMA_LEDGER_AUTHORITY_UNSAFE');await ledger(c,p.from);await stopped(c);const before=await preservation(c);checkpoint();
  await c.query(plan.sql.toString('utf8'));checkpoint();await c.query('INSERT INTO public.schema_migrations(name,hash) VALUES($1,$2)',[plan.migration.name,plan.migration.hash]);await ledger(c,p.to);if((await c.query('SELECT public.oa_schema_ledger_read_only() safe')).rows[0]?.safe!==true)fail('SCHEMA_LEDGER_AUTHORITY_UNSAFE');await stopped(c);if(await preservation(c)!==before)fail('PRESERVED_STATE_CHANGED');checkpoint();await databaseWindow();checkpoint();
  commitStarted=true;await c.query('COMMIT');committed=true;
  outcome={...base,status:'STEP_COMMITTED',sqlSha256:plan.migration.hash,preservationFingerprint:before};
  }catch(error){
   if(lifetime.overrun())lifetime.abort();
   if(connected&&!commitStarted&&!signal.aborted)await c.query('ROLLBACK').catch(()=>{});
   outcome={...base,status:commitStarted&&!committed?'UNKNOWN':'REJECTED_ROLLED_BACK_OR_NOT_STARTED',code:commitStarted?'COMMIT_OUTCOME_UNCERTAIN':error instanceof MigrationStepFailure?error.code:signal.aborted?'CANCELLED_OR_TIMEOUT':'STEP_FAILED',sqlState:typeof (error as {code?:unknown}).code==='string'&&/^[0-9A-Z]{5}$/.test((error as {code:string}).code)?(error as {code:string}).code:null};
  }
 }finally{
  // Keep the work deadline active while ending. A late end() settlement is
  // always owned, even if the finite cleanup grace cannot confirm it.
  lifetime.keepAlive();if(lifetime.overrun())lifetime.abort();
  if(client){
   const pending=end(),finished=await settledBeforeAbort(pending,signal);
   if(finished&&socketClosed)cleanupOutcome='CONFIRMED';
   else{stop();const confirmed=await settledDuringCleanup(Promise.all([pending,closed!]).then(([ended])=>ended&&socketClosed));cleanupOutcome=confirmed?'CONFIRMED':'UNCONFIRMED';}
  }else socket?.destroy();
  signal.removeEventListener('abort',stop);lifetime.dispose();bytes?.fill(0);plan?.sql.fill(0);
 }
 if(!outcome)fail('STEP_FAILED');
 return {...outcome,cleanupOutcome,deadlineOverrunObserved:signal.aborted||lifetime.overrun(),cleanupGraceMs:1000};
}
