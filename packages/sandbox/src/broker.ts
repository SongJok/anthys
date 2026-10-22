import {createHash} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {types} from 'node:util';
import type pg from 'pg';
import {AnalysisJobError,verifyAnalysisJob,type AnalysisJob,type AnalysisJobPayload,type AnalysisJobSubject} from '../../analysis/src/job-contract.js';
import type {Database,DbContext} from '../../storage/src/database.js';
import {inspectZip} from '../../artifacts/src/zip.js';
import type {SandboxExecutionResult,SandboxInput} from './executor.js';

const codeLimit=1024*1024,inputLimit=8*1024*1024,fileLimit=64,logLimit=64*1024,resultLimit=64*1024,pollFloor=50,pollCeiling=10_000,recheckFloor=250,recheckCeiling=60_000,recheckDefault=5_000;
const ooxmlLimits={maxZipEntries:512,maxExpandedBytes:64*1024*1024,maxCompressionRatio:1000} as const;
const digestPattern=/^[a-f0-9]{64}$/,imageDigestPattern=/^sha256:[a-f0-9]{64}$/,keyIdPattern=/^[A-Za-z0-9_-]{1,64}$/,failurePattern=/^[A-Z0-9_]{1,64}$/,fileNamePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,brokerIdPattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const outputExtensions:Record<string,{extension:string;mime:string}>={markdown:{extension:'md',mime:'text/markdown'},txt:{extension:'txt',mime:'text/plain'},csv:{extension:'csv',mime:'text/csv'},json:{extension:'json',mime:'application/json'},html:{extension:'html',mime:'text/html'},xlsx:{extension:'xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},docx:{extension:'docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},pdf:{extension:'pdf',mime:'application/pdf'}};
const terminalStates=['SUCCEEDED','FAILED','TIMEOUT','CANCELLED','LIMIT_EXCEEDED','REJECTED'] as const;

export type SandboxTerminalState=typeof terminalStates[number];
export type SandboxBrokerErrorCode='SANDBOX_BROKER_CONFIGURATION_INVALID'|'SANDBOX_BROKER_WIRE_INVALID'|'SANDBOX_BROKER_REPLAYED'|'SANDBOX_BROKER_QUOTA_EXCEEDED'|'SANDBOX_BROKER_NOT_AUTHORIZED'|'SANDBOX_BROKER_CANCELLED'|'SANDBOX_BROKER_STATE_INVALID'|'SANDBOX_BROKER_UNAVAILABLE';
export class SandboxBrokerError extends Error {
 constructor(readonly code:SandboxBrokerErrorCode){super(code);this.name='SandboxBrokerError';}
}

export type SandboxAuthorizer={authorize(payload:AnalysisJobPayload,signal:AbortSignal):Promise<{authorized:boolean;reason?:string}>};
/** Must resolve against the current owner ACL; returned bytes are treated as the job's only artifact content. */
export type SandboxArtifactResolver={resolve(artifactId:string,subject:AnalysisJobSubject,signal:AbortSignal):Promise<Uint8Array>};
export type SandboxVerifiedOutput=Readonly<{name:string;mime:string;sha256:string;byteSize:number}>;
export type SandboxResultSink={
 persist(input:Readonly<{
  payload:AnalysisJobPayload;state:SandboxTerminalState;failureCode:string|null;durationMs:number;
  outputs:readonly (SandboxVerifiedOutput&{bytes:Uint8Array})[];
  stdout:string;stderr:string;codeSha256:string;inputHashes:readonly {artifactId:string;sha256:string;byteSize:number}[];
 }>):Promise<{reference:string}>;
};
export type SandboxExecutable={execute(job:AnalysisJob,code:string,inputs:readonly SandboxInput[],signal:AbortSignal):Promise<SandboxExecutionResult>};
export type SandboxBrokerOutcome=Readonly<{
 jobId:string;state:SandboxTerminalState;failureCode:string|null;artifactReference:string|null;
 outputs:readonly SandboxVerifiedOutput[];durationMs:number;
}>;
export type SandboxBrokerOptions=Readonly<{
 keyId:string;publicKey:KeyObject;imageDigest:string;brokerId:string;store:PgSandboxBrokerStore;authorizer:SandboxAuthorizer;resolver:SandboxArtifactResolver;sink:SandboxResultSink;executor:SandboxExecutable;
 now?:()=>number;cancelPollMs?:number;authorizationRecheckMs?:number;
}>;
export type SandboxBrokerQuota=Readonly<{maxActivePerOwner:number;maxJobsPerDay:number}>;
export type SandboxStoredJob=Readonly<{
 jobId:string;state:string;failureCode:string|null;cancelRequested:boolean;
 createdAt:string;startedAt:string|null;completedAt:string|null;result:unknown;version:number;
}>;

function configuration(options:SandboxBrokerOptions){
 if(typeof options.keyId!=='string'||!keyIdPattern.test(options.keyId)||typeof options.imageDigest!=='string'||!imageDigestPattern.test(options.imageDigest)||typeof options.brokerId!=='string'||!brokerIdPattern.test(options.brokerId))throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
 const poll=options.cancelPollMs??250,recheck=options.authorizationRecheckMs??recheckDefault;
 if(!Number.isSafeInteger(poll)||poll<pollFloor||poll>pollCeiling)throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
 if(!Number.isSafeInteger(recheck)||recheck<recheckFloor||recheck>recheckCeiling)throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
 if(!options.publicKey||options.publicKey.type!=='public'||options.publicKey.asymmetricKeyType!=='ed25519')throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
 for(const dependency of [options.store,options.authorizer,options.resolver,options.sink,options.executor])if(!dependency||typeof dependency!=='object')throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
}
function quotaCheck(quota:SandboxBrokerQuota){
 if(!quota||!Number.isSafeInteger(quota.maxActivePerOwner)||quota.maxActivePerOwner<1||quota.maxActivePerOwner>64||!Number.isSafeInteger(quota.maxJobsPerDay)||quota.maxJobsPerDay<1||quota.maxJobsPerDay>10_000)throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
}
function principal(subject:AnalysisJobSubject):DbContext{return {tenantId:subject.tenantId,actorId:subject.actorId};}
function instant(value:unknown):string{return new Date(value as string|Date).toISOString();}
function failure(value:unknown,fallback:string){return typeof value==='string'&&failurePattern.test(value)?value:fallback;}
function boundedBytes(value:unknown,max:number,allowEmpty:boolean):Buffer{
 if(!(value instanceof Uint8Array)||types.isProxy(value))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 const bytes=Buffer.from(value);
 if(bytes.length>max||(!allowEmpty&&bytes.length===0))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 return bytes;
}
function decode(value:Buffer){return new TextDecoder('utf-8',{fatal:true}).decode(value);}
function sha256(value:Uint8Array){return createHash('sha256').update(value).digest('hex');}
function ooxmlCheck(bytes:Buffer,requiredEntry:string){
 try{return inspectZip(bytes,ooxmlLimits).has(requiredEntry);}catch{return false;}
}
function inspectOutput(name:string,bytes:Buffer,allowed:readonly string[]):SandboxVerifiedOutput{
 if(!fileNamePattern.test(name))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 if(bytes.length===0)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 const extension=name.toLowerCase().split('.').pop()??'',spec=Object.values(outputExtensions).find(item=>item.extension===extension);
 if(!spec||!allowed.includes(extension))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 if(['md','txt','csv','html','json'].includes(extension)){
  const text=decode(bytes);
  if(text.includes('\0'))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
  if(extension==='json'){try{JSON.parse(text);}catch{throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');}}
  if(extension==='html'&&!/<(?:!doctype\s+html|html)[\s>]/i.test(text.slice(0,4096)))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 }else if(extension==='pdf'){
  if(bytes.subarray(0,1024).indexOf(Buffer.from('%PDF-','ascii'))<0||bytes.subarray(Math.max(0,bytes.length-2048)).indexOf(Buffer.from('%%EOF','ascii'))<0)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 }else if(extension==='xlsx'&&!ooxmlCheck(bytes,'xl/workbook.xml'))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 else if(extension==='docx'&&!ooxmlCheck(bytes,'word/document.xml'))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 return Object.freeze({name,mime:spec.mime,sha256:sha256(bytes),byteSize:bytes.length});
}
function verifiedOutputs(result:SandboxExecutionResult,job:AnalysisJob){
 if(!result||typeof result!=='object'||!(['SUCCEEDED','FAILED','TIMEOUT','CANCELLED','LIMIT_EXCEEDED'] as readonly string[]).includes(result.state))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 if(!Array.isArray(result.outputs)||result.outputs.length>fileLimit||typeof result.stdout!=='string'||typeof result.stderr!=='string'||Buffer.byteLength(result.stdout,'utf8')>logLimit||Buffer.byteLength(result.stderr,'utf8')>logLimit||!Number.isSafeInteger(result.durationMs)||result.durationMs<0||!(result.exitCode===null||Number.isSafeInteger(result.exitCode))||typeof result.oomKilled!=='boolean'||!(['NONE','PROCESS_FAILED','OOM_KILLED','WALL_TIMEOUT','CANCELLED','OUTPUT_LIMIT','OUTPUT_INVALID'] as readonly string[]).includes(result.reason))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 if(result.state!=='SUCCEEDED'){if(result.outputs.length!==0)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');return Object.freeze([]) as readonly (SandboxVerifiedOutput&{bytes:Uint8Array})[];}
 if(result.reason!=='NONE')throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 const allowed=job.allowedOutputTypes.map(type=>outputExtensions[type]!.extension),names=new Set<string>(),values:(SandboxVerifiedOutput&{bytes:Uint8Array})[]=[];let total=0;
 for(const raw of result.outputs){
  if(!raw||typeof raw!=='object'||typeof raw.name!=='string'||names.has(raw.name)||typeof raw.sha256!=='string'||!digestPattern.test(raw.sha256))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
  const bytes=boundedBytes(raw.bytes,job.limits.outputBytes,false),verified=inspectOutput(raw.name,bytes,allowed);
  if(verified.sha256!==raw.sha256)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
  total+=bytes.length;if(total>job.limits.outputBytes)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
  names.add(raw.name);values.push(Object.freeze({...verified,bytes}));
 }
 return Object.freeze(values);
}
function storedResult(input:{state:SandboxTerminalState;failureCode:string|null;durationMs:number;artifactReference:string|null;outputs:readonly SandboxVerifiedOutput[];stdout:string;stderr:string;codeSha256:string;inputHashes:readonly {artifactId:string;sha256:string;byteSize:number}[];executorState?:string;reason?:string;exitCode?:number|null;oomKilled?:boolean}){
 const value={version:1,state:input.state,failureCode:input.failureCode,durationMs:input.durationMs,artifactReference:input.artifactReference,outputs:input.outputs.map(({name,mime,sha256,byteSize})=>({name,mime,sha256,byteSize})),stdoutBytes:Buffer.byteLength(input.stdout,'utf8'),stderrBytes:Buffer.byteLength(input.stderr,'utf8'),codeSha256:input.codeSha256,inputHashes:input.inputHashes,...(input.executorState?{executorState:input.executorState}:{}),...(input.reason?{reason:input.reason}:{}),...(input.exitCode!==undefined?{exitCode:input.exitCode}:{}),...(input.oomKilled!==undefined?{oomKilled:input.oomKilled}:{})};
 const serialized=JSON.stringify(value);if(Buffer.byteLength(serialized,'utf8')>resultLimit)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
 return JSON.parse(serialized) as Record<string,unknown>;
}

/** Durable admission state. Rows are owner-scoped; uniqueness on (tenant,nonce) rejects signed-envelope replay. */
export class PgSandboxBrokerStore {
 private readonly quota:SandboxBrokerQuota;
 constructor(private readonly db:Database,quota:SandboxBrokerQuota={maxActivePerOwner:2,maxJobsPerDay:100}){quotaCheck(quota);this.quota=Object.freeze({...quota});}
 private scope<T>(subject:AnalysisJobSubject,fn:(client:pg.PoolClient)=>Promise<T>){return this.db.scope(principal(subject),fn);}
 async claim(payload:AnalysisJobPayload,brokerId:string):Promise<void>{
  if(typeof brokerId!=='string'||!brokerIdPattern.test(brokerId))throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
  const subject=payload.subject;
  await this.scope(subject,async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${subject.tenantId}:${subject.actorId}:sandbox-broker`]);
   const inserted=await client.query("INSERT INTO sandbox_broker_jobs(tenant_id,job_id,task_id,run_id,actor_id,auth_epoch,nonce,image_digest,job_hash,state,expires_at,broker_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RESERVED',$10,$11) ON CONFLICT DO NOTHING RETURNING job_id",[subject.tenantId,payload.job.jobId,payload.job.taskId,payload.job.runId,subject.actorId,subject.authEpoch,payload.nonce,payload.imageDigest,payload.jobHash,new Date(payload.expiresAt).toISOString(),brokerId]);
   if(!inserted.rowCount)throw new SandboxBrokerError('SANDBOX_BROKER_REPLAYED');
   const counts=(await client.query("SELECT count(*) FILTER(WHERE state IN ('RESERVED','RUNNING')) active,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '24 hours') recent FROM sandbox_broker_jobs WHERE tenant_id=$1 AND actor_id=$2",[subject.tenantId,subject.actorId])).rows[0] as {active:string;recent:string};
   if(Number(counts.active)>this.quota.maxActivePerOwner||Number(counts.recent)>this.quota.maxJobsPerDay)throw new SandboxBrokerError('SANDBOX_BROKER_QUOTA_EXCEEDED');
  });
 }
 async begin(payload:AnalysisJobPayload):Promise<'RUNNING'|'CANCELLED'|'EXPIRED'|'STATE_INVALID'>{
  const subject=payload.subject;
  return this.scope(subject,async client=>{
   const row=(await client.query('SELECT state,cancel_requested_at,expires_at FROM sandbox_broker_jobs WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE',[subject.tenantId,payload.job.jobId])).rows[0] as {state:string;cancel_requested_at:Date|null;expires_at:Date}|undefined;
   if(!row||row.state!=='RESERVED')return 'STATE_INVALID';
   if(row.cancel_requested_at)return (await client.query("UPDATE sandbox_broker_jobs SET state='CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND job_id=$2 AND state='RESERVED'",[subject.tenantId,payload.job.jobId])).rowCount?'CANCELLED':'STATE_INVALID';
   if(new Date(row.expires_at).getTime()<=Date.now())return (await client.query("UPDATE sandbox_broker_jobs SET state='FAILED',failure_code='SANDBOX_JOB_EXPIRED',completed_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND job_id=$2 AND state='RESERVED'",[subject.tenantId,payload.job.jobId])).rowCount?'EXPIRED':'STATE_INVALID';
   return (await client.query("UPDATE sandbox_broker_jobs SET state='RUNNING',started_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND job_id=$2 AND state='RESERVED' AND cancel_requested_at IS NULL",[subject.tenantId,payload.job.jobId])).rowCount?'RUNNING':'STATE_INVALID';
  });
 }
 async cancellationRequested(subject:AnalysisJobSubject,jobId:string):Promise<boolean>{
  return this.scope(subject,async client=>{
   const row=(await client.query("SELECT cancel_requested_at IS NOT NULL requested FROM sandbox_broker_jobs WHERE tenant_id=$1 AND job_id=$2 AND state IN ('RESERVED','RUNNING')",[subject.tenantId,jobId])).rows[0] as {requested:boolean}|undefined;
   return row?.requested===true;
  });
 }
 async requestCancel(subject:AnalysisJobSubject,jobId:string):Promise<boolean>{
  return this.scope(subject,async client=>(await client.query("UPDATE sandbox_broker_jobs SET cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND job_id=$2 AND state IN ('RESERVED','RUNNING')",[subject.tenantId,jobId])).rowCount===1);
 }
 async finish(payload:AnalysisJobPayload,state:SandboxTerminalState,failureCode:string|null,result:Record<string,unknown>|null):Promise<void>{
  if(!terminalStates.includes(state)||failureCode!==null&&!failurePattern.test(failureCode))throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
  const serialized=result?JSON.stringify(result):null;if(serialized&&Buffer.byteLength(serialized,'utf8')>resultLimit)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
  await this.scope(payload.subject,async client=>{
   const updated=await client.query("UPDATE sandbox_broker_jobs SET state=$3,failure_code=$4,result=$5,completed_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND job_id=$2 AND state IN ('RESERVED','RUNNING')",[payload.subject.tenantId,payload.job.jobId,state,failureCode,serialized]);
   if(updated.rowCount)return;
   const row=(await client.query('SELECT state FROM sandbox_broker_jobs WHERE tenant_id=$1 AND job_id=$2',[payload.subject.tenantId,payload.job.jobId])).rows[0] as {state:string}|undefined;
   if(!row||row.state!==state)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
  });
 }
 /** Settles only this broker's interrupted RESERVED/RUNNING rows. Call at
  * startup before accepting new submissions; other brokers are untouched. */
 async recoverInterrupted(brokerId:string):Promise<number>{
  if(typeof brokerId!=='string'||!brokerIdPattern.test(brokerId))throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
  try{
   const row=(await this.db.pool.query<{n:number}>('SELECT public.oa_sandbox_broker_recover($1) n',[brokerId])).rows[0];
   if(!row||!Number.isSafeInteger(Number(row.n))||Number(row.n)<0)throw new SandboxBrokerError('SANDBOX_BROKER_UNAVAILABLE');
   return Number(row.n);
  }catch(error){if(error instanceof SandboxBrokerError)throw error;throw new SandboxBrokerError('SANDBOX_BROKER_UNAVAILABLE');}
 }
 async get(subject:AnalysisJobSubject,jobId:string):Promise<SandboxStoredJob|null>{
  return this.scope(subject,async client=>{
   const row=(await client.query('SELECT job_id,state,failure_code,cancel_requested_at,created_at,started_at,completed_at,result,version FROM sandbox_broker_jobs WHERE tenant_id=$1 AND job_id=$2',[subject.tenantId,jobId])).rows[0] as Record<string,unknown>|undefined;
   if(!row)return null;
   return Object.freeze({jobId:row.job_id as string,state:row.state as string,failureCode:row.failure_code as string|null,cancelRequested:row.cancel_requested_at!==null,createdAt:instant(row.created_at),startedAt:row.started_at===null?null:instant(row.started_at),completedAt:row.completed_at===null?null:instant(row.completed_at),result:row.result,version:Number(row.version)});
  });
 }
}

/**
 * Verifies one signed OA_ANALYSIS_JOB_V1 envelope, durably admits its nonce,
 * rechecks authorization, resolves the exact artifacts, executes through the
 * injected sandbox and records bounded evidence. It never accepts an image,
 * mount, path or credential from the request. Artifact bytes must be persisted
 * by the injected sink; this broker stores metadata only. `expectedSubject`
 * must be derived from the authenticated caller, never from the wire, and the
 * composing executor must use the same pinned image digest configured here.
 */
export class SandboxBroker {
 private readonly options:SandboxBrokerOptions;
 constructor(options:SandboxBrokerOptions){configuration(options);this.options=options;}
 private now(){return this.options.now?.()??Date.now();}
 async submit(wire:string|Uint8Array,expectedSubject:AnalysisJobSubject,signal?:AbortSignal):Promise<SandboxBrokerOutcome>{
  if(signal?.aborted)throw new SandboxBrokerError('SANDBOX_BROKER_CANCELLED');
  let payload:AnalysisJobPayload;
  try{payload=verifyAnalysisJob(wire,{expectedSubject,imageDigest:this.options.imageDigest,keyId:this.options.keyId,publicKey:this.options.publicKey,now:this.now()});}
  catch(error){
   if(error instanceof AnalysisJobError&&(error.code==='ANALYSIS_JOB_KEY_INVALID'||error.code==='ANALYSIS_JOB_CONFIGURATION_INVALID'))throw new SandboxBrokerError('SANDBOX_BROKER_CONFIGURATION_INVALID');
   throw new SandboxBrokerError('SANDBOX_BROKER_WIRE_INVALID');
  }
  const subject=payload.subject;
  try{await this.options.store.claim(payload,this.options.brokerId);}catch(error){if(error instanceof SandboxBrokerError)throw error;throw new SandboxBrokerError('SANDBOX_BROKER_UNAVAILABLE');}
  const controller=new AbortController();let pollFailure=false,authDenied=false,authFailure=false,busy=false,stopped=false,lastAuthorization=this.now();
  const recheckMs=this.options.authorizationRecheckMs??recheckDefault;
  const cancel=async()=>{try{await this.options.store.requestCancel(subject,payload.job.jobId);}catch{}controller.abort();};
  const external=()=>{void cancel();};
  if(signal){if(signal.aborted)external();else signal.addEventListener('abort',external,{once:true});}
  const timer=setInterval(()=>{
   if(stopped||busy)return;busy=true;
   void (async()=>{
    try{
     if(await this.options.store.cancellationRequested(subject,payload.job.jobId)){controller.abort();return;}
     if(this.now()-lastAuthorization<recheckMs)return;
     lastAuthorization=this.now();
     try{const current=await this.options.authorizer.authorize(payload,controller.signal);if(current?.authorized!==true)authDenied=true;}
     catch{if(!controller.signal.aborted)authFailure=true;}
     if(authDenied||authFailure)controller.abort();
    }catch{pollFailure=true;controller.abort();}
   })().finally(()=>{busy=false;});
  },this.options.cancelPollMs??250);timer.unref();
  const stop=()=>{stopped=true;clearInterval(timer);signal?.removeEventListener('abort',external);};
  let code:Buffer=Buffer.alloc(0),codeSha256='',inputs:readonly SandboxInput[]=Object.freeze([]),inputHashes:readonly {artifactId:string;sha256:string;byteSize:number}[]=Object.freeze([]);
  try{
   if(controller.signal.aborted)return await this.settle(payload,'CANCELLED',null,storedResult({state:'CANCELLED',failureCode:null,durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256, inputHashes}));
   let decision:{authorized:boolean;reason?:string};
   try{decision=await this.options.authorizer.authorize(payload,controller.signal);}
   catch{
    const cancelled=controller.signal.aborted,state:SandboxTerminalState=cancelled?'CANCELLED':'FAILED',failureCode=cancelled?null:'AUTHORIZATION_UNAVAILABLE';
    return await this.settle(payload,state,failureCode,storedResult({state,failureCode,durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
   }
   if(decision?.authorized!==true)return await this.settle(payload,'REJECTED',failure(decision?.reason,'AUTHORIZATION_DENIED'),storedResult({state:'REJECTED',failureCode:failure(decision?.reason,'AUTHORIZATION_DENIED'),durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
   try{
    code=boundedBytes(await this.options.resolver.resolve(payload.job.codeArtifactId,payload.subject,controller.signal),codeLimit,false);codeSha256=sha256(code);
    const resolved:SandboxInput[]=[],hashes:{artifactId:string;sha256:string;byteSize:number}[]=[];let total=0;
    for(const artifactId of payload.job.inputArtifactIds){
     const bytes=boundedBytes(await this.options.resolver.resolve(artifactId,payload.subject,controller.signal),inputLimit,true);total+=bytes.length;
     if(total>inputLimit)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
     resolved.push(Object.freeze({artifactId,bytes}));hashes.push({artifactId,sha256:sha256(bytes),byteSize:bytes.length});
    }
    inputs=Object.freeze(resolved);inputHashes=Object.freeze(hashes);
   }catch{
    if(controller.signal.aborted)return await this.settle(payload,'CANCELLED',null,storedResult({state:'CANCELLED',failureCode:null,durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
    return await this.settle(payload,'FAILED','ARTIFACT_RESOLUTION_FAILED',storedResult({state:'FAILED',failureCode:'ARTIFACT_RESOLUTION_FAILED',durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
   }
   let text:string;
   try{text=decode(code);}catch{return await this.settle(payload,'FAILED','CODE_INVALID',storedResult({state:'FAILED',failureCode:'CODE_INVALID',durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));}
   let begun:'RUNNING'|'CANCELLED'|'EXPIRED'|'STATE_INVALID';
   try{begun=await this.options.store.begin(payload);}catch{throw new SandboxBrokerError('SANDBOX_BROKER_UNAVAILABLE');}
   if(begun==='CANCELLED')return await this.settle(payload,'CANCELLED',null,storedResult({state:'CANCELLED',failureCode:null,durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
   if(begun==='EXPIRED')return Object.freeze({jobId:payload.job.jobId,state:'FAILED',failureCode:'SANDBOX_JOB_EXPIRED',artifactReference:null,outputs:[],durationMs:0});
   if(begun!=='RUNNING')throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
   let execution:SandboxExecutionResult;
   try{execution=await this.options.executor.execute(payload.job,text,inputs,controller.signal);}
   catch(error){
    if(authDenied)return await this.settle(payload,'REJECTED','AUTHORIZATION_REVOKED',storedResult({state:'REJECTED',failureCode:'AUTHORIZATION_REVOKED',durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
    if(authFailure)return await this.settle(payload,'FAILED','AUTHORIZATION_RECHECK_FAILED',storedResult({state:'FAILED',failureCode:'AUTHORIZATION_RECHECK_FAILED',durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
    const cancelled=controller.signal.aborted;
    const failureCode=cancelled?(pollFailure?'CANCELLATION_CHECK_FAILED':null):(error instanceof Error&&'code'in error?failure((error as {code:unknown}).code,'EXECUTOR_FAILED'):'EXECUTOR_FAILED');
    return await this.settle(payload,cancelled?'CANCELLED':'FAILED',failureCode,storedResult({state:cancelled?'CANCELLED':'FAILED',failureCode,durationMs:0,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
   }
   if(authDenied)return await this.settle(payload,'REJECTED','AUTHORIZATION_REVOKED',storedResult({state:'REJECTED',failureCode:'AUTHORIZATION_REVOKED',durationMs:execution.durationMs,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
   if(authFailure)return await this.settle(payload,'FAILED','AUTHORIZATION_RECHECK_FAILED',storedResult({state:'FAILED',failureCode:'AUTHORIZATION_RECHECK_FAILED',durationMs:execution.durationMs,artifactReference:null,outputs:[],stdout:'',stderr:'',codeSha256,inputHashes}));
   let outputs:readonly (SandboxVerifiedOutput&{bytes:Uint8Array})[];
   try{outputs=verifiedOutputs(execution,payload.job);}
   catch{return await this.settle(payload,'FAILED','OUTPUT_INVALID',storedResult({state:'FAILED',failureCode:'OUTPUT_INVALID',durationMs:execution.durationMs,artifactReference:null,outputs:[],stdout:execution.stdout,stderr:execution.stderr,codeSha256,inputHashes,executorState:execution.state,reason:execution.reason,exitCode:execution.exitCode,oomKilled:execution.oomKilled}));}
   const state:SandboxTerminalState=pollFailure&&execution.state==='CANCELLED'?'FAILED':execution.state;
   const failureCode=pollFailure&&execution.state==='CANCELLED'?'CANCELLATION_CHECK_FAILED':state==='SUCCEEDED'||state==='CANCELLED'?null:failure(execution.reason,'EXECUTION_FAILED');
   let reference:string|null=null;
   try{
    const persisted=(await this.options.sink.persist({payload,state,failureCode,durationMs:execution.durationMs,outputs,stdout:execution.stdout,stderr:execution.stderr,codeSha256,inputHashes})).reference;
    if(typeof persisted!=='string'||persisted.length===0||persisted.length>512)throw new SandboxBrokerError('SANDBOX_BROKER_STATE_INVALID');
    reference=persisted;
   }catch{return await this.settle(payload,'FAILED','RESULT_PERSISTENCE_FAILED',storedResult({state:'FAILED',failureCode:'RESULT_PERSISTENCE_FAILED',durationMs:execution.durationMs,artifactReference:null,outputs:[],stdout:execution.stdout,stderr:execution.stderr,codeSha256,inputHashes,executorState:execution.state,reason:execution.reason,exitCode:execution.exitCode,oomKilled:execution.oomKilled}));}
   return await this.settle(payload,state,failureCode,storedResult({state,failureCode,durationMs:execution.durationMs,artifactReference:reference,outputs,stdout:execution.stdout,stderr:execution.stderr,codeSha256,inputHashes,executorState:execution.state,reason:execution.reason,exitCode:execution.exitCode,oomKilled:execution.oomKilled}),reference);
  }finally{stop();}
 }
 private async settle(payload:AnalysisJobPayload,state:SandboxTerminalState,failureCode:string|null,result:Record<string,unknown>,reference:string|null=null):Promise<SandboxBrokerOutcome>{
  try{await this.options.store.finish(payload,state,failureCode,result);}catch{throw new SandboxBrokerError('SANDBOX_BROKER_UNAVAILABLE');}
  const raw=result['outputs'];const outputs=Array.isArray(raw)?raw.map(item=>Object.freeze(item as SandboxVerifiedOutput)):Object.freeze([]);
  return Object.freeze({jobId:payload.job.jobId,state,failureCode,artifactReference:reference,outputs:Object.freeze(outputs),durationMs:Number(result['durationMs']??0)});
 }
}
