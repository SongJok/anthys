import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import type pg from 'pg';
import type {AnalysisJobSubject} from '../../analysis/src/job-contract.js';
import type {Database,DbContext} from '../../storage/src/database.js';
import type {FileStore} from '../../storage/src/files.js';
import type {SandboxArtifactResolver,SandboxResultSink} from './broker.js';

const codeLimit=1024*1024,inputLimit=8*1024*1024,outputLimit=20*1024*1024,maxTtlMs=7*24*60*60*1000,defaultTtlMs=24*60*60*1000;
const namePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,mimePattern=/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/,digestPattern=/^[a-f0-9]{64}$/;

export type SandboxArtifactRef=Readonly<{id:string;kind:'CODE'|'INPUT'|'OUTPUT';name:string|null;mime:string;sha256:string;byteSize:number;expiresAt:string}>;
export type SandboxArtifactPut=Readonly<{kind:'CODE'|'INPUT';name?:string;mime:string;bytes:Uint8Array;expiresAt?:string}>;
export type SandboxArtifactErrorCode='SANDBOX_ARTIFACT_INVALID'|'SANDBOX_ARTIFACT_NOT_FOUND'|'SANDBOX_ARTIFACT_INTEGRITY_FAILED'|'SANDBOX_ARTIFACT_UNAVAILABLE'|'SANDBOX_ARTIFACT_CANCELLED';
export class SandboxArtifactError extends Error {
 constructor(readonly code:SandboxArtifactErrorCode){super(code);this.name='SandboxArtifactError';}
}

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const instant=(value:unknown)=>new Date(value as string|Date).toISOString();
function bounded(value:unknown,max:number):Buffer{
 if(!(value instanceof Uint8Array)||types.isProxy(value))throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
 const bytes=Buffer.from(value);
 if(bytes.length===0||bytes.length>max)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
 return bytes;
}
function checkedName(value:unknown):string{
 if(typeof value!=='string'||!namePattern.test(value))throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
 return value;
}
function checkedMime(value:unknown):string{
 if(typeof value!=='string')throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
 const base=value.split(';')[0]!.trim().toLowerCase();
 if(!mimePattern.test(base))throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
 return base;
}
type Row=pg.QueryResultRow;
function metadata(row:Row):SandboxArtifactRef{
 return Object.freeze({id:row.id as string,kind:row.kind as SandboxArtifactRef['kind'],name:row.name as string|null,mime:row.mime as string,sha256:row.sha256 as string,byteSize:Number(row.byte_size),expiresAt:instant(row.expires_at)});
}

/**
 * Concrete broker artifact boundary backed by owner-scoped PostgreSQL metadata
 * and the encrypted file store. `put` is for the trusted job producer; `resolve`
 * and `persist` implement the broker interfaces and never return a reference
 * for bytes that were not hash-verified. Output rows are created only after the
 * broker verified the execution result.
 */
export class PgSandboxArtifactConnector implements SandboxArtifactResolver,SandboxResultSink {
 constructor(private readonly db:Database,private readonly files:FileStore,private readonly options:{ttlMs?:number;now?:()=>number}={}){}
 private now(){return this.options.now?.()??Date.now();}
 private scope<T>(subject:DbContext,fn:(client:pg.PoolClient)=>Promise<T>){return this.db.scope(subject,fn);}
 private expiry(value?:string){
  const now=this.now(),ttl=this.options.ttlMs??defaultTtlMs;
  if(!Number.isSafeInteger(ttl)||ttl<60_000||ttl>maxTtlMs)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
  const at=value===undefined?now+ttl:Date.parse(value);
  if(!Number.isFinite(at)||at<=now||at>now+maxTtlMs)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
  return new Date(at).toISOString();
 }
 async put(subject:DbContext,raw:SandboxArtifactPut):Promise<SandboxArtifactRef>{
  if(!raw||typeof raw!=='object'||(raw.kind!=='CODE'&&raw.kind!=='INPUT'))throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
  const bytes=bounded(raw.bytes,raw.kind==='CODE'?codeLimit:inputLimit),mime=checkedMime(raw.mime),name=raw.name===undefined?null:checkedName(raw.name);
  const id=randomUUID(),storageKey=`${subject.tenantId}/${subject.actorId}/${id}/${randomUUID()}.sealed`,sha256=digest(bytes),expiresAt=this.expiry(raw.expiresAt);
  try{
   await this.scope(subject,async client=>{await client.query("INSERT INTO sandbox_artifacts(tenant_id,id,owner_id,kind,state,name,mime,sha256,byte_size,storage_key,expires_at) VALUES($1,$2,$3,$4,'PREPARING',$5,$6,$7,$8,$9,$10)",[subject.tenantId,id,subject.actorId,raw.kind,name,mime,sha256,bytes.length,storageKey,expiresAt]);});
  }catch{throw new SandboxArtifactError('SANDBOX_ARTIFACT_UNAVAILABLE');}
  try{
   await this.files.put(storageKey,bytes);
   return await this.scope(subject,async client=>{
    const row=(await client.query("UPDATE sandbox_artifacts SET state='READY' WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND state='PREPARING' RETURNING *",[subject.tenantId,subject.actorId,id])).rows[0];
    if(!row)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INTEGRITY_FAILED');
    return metadata(row);
   });
  }catch(error){
   await this.files.remove(storageKey).catch(()=>{});
   await this.scope(subject,client=>client.query("UPDATE sandbox_artifacts SET state='FAILED' WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND state='PREPARING'",[subject.tenantId,subject.actorId,id])).catch(()=>{});
   if(error instanceof SandboxArtifactError)throw error;
   throw new SandboxArtifactError('SANDBOX_ARTIFACT_UNAVAILABLE');
  }
 }
 async resolve(artifactId:string,subject:AnalysisJobSubject,signal:AbortSignal):Promise<Uint8Array>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifactId)||signal.aborted)throw new SandboxArtifactError(signal.aborted?'SANDBOX_ARTIFACT_CANCELLED':'SANDBOX_ARTIFACT_INVALID');
  let row:Row|undefined;
  try{row=await this.scope(subject,async client=>(await client.query("SELECT id,kind,name,mime,sha256,byte_size,storage_key,expires_at FROM sandbox_artifacts WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND state='READY' AND expires_at>clock_timestamp()",[subject.tenantId,subject.actorId,artifactId])).rows[0]);}
  catch{throw new SandboxArtifactError('SANDBOX_ARTIFACT_UNAVAILABLE');}
  if(!row)throw new SandboxArtifactError('SANDBOX_ARTIFACT_NOT_FOUND');
  let bytes:Buffer;
  try{bytes=await this.files.get(row.storage_key as string);}catch{throw new SandboxArtifactError('SANDBOX_ARTIFACT_INTEGRITY_FAILED');}
  if(bytes.length!==Number(row.byte_size)||digest(bytes)!==row.sha256)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INTEGRITY_FAILED');
  if(signal.aborted)throw new SandboxArtifactError('SANDBOX_ARTIFACT_CANCELLED');
  return bytes;
 }
 async persist(input:Parameters<SandboxResultSink['persist']>[0]):Promise<{reference:string}>{
  const {payload,outputs}=input,subject=payload.subject,jobId=payload.job.jobId;
  if(!Array.isArray(outputs)||outputs.length>64)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
  if(outputs.length===0)return {reference:'sandbox-job:'+jobId};
  let total=0;const pending:{id:string;key:string;name:string;mime:string;sha256:string;bytes:Buffer}[]=[];
  for(const output of outputs){
   if(!output||typeof output.name!=='string'||!namePattern.test(output.name)||typeof output.mime!=='string'||typeof output.sha256!=='string'||!digestPattern.test(output.sha256)||!Number.isSafeInteger(output.byteSize))throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
   const bytes=bounded(output.bytes,outputLimit);
   if(bytes.length!==output.byteSize||digest(bytes)!==output.sha256)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INTEGRITY_FAILED');
   total+=bytes.length;if(total>payload.job.limits.outputBytes)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INVALID');
   const id=randomUUID();pending.push({id,key:`${subject.tenantId}/${subject.actorId}/${id}/${randomUUID()}.sealed`,name:output.name,mime:checkedMime(output.mime),sha256:output.sha256,bytes});
  }
  const expiresAt=this.expiry();
  try{
   await this.scope(subject,async client=>{
    for(const item of pending)await client.query("INSERT INTO sandbox_artifacts(tenant_id,id,owner_id,kind,state,job_id,name,mime,sha256,byte_size,storage_key,expires_at) VALUES($1,$2,$3,'OUTPUT','PREPARING',$4,$5,$6,$7,$8,$9,$10)",[subject.tenantId,item.id,subject.actorId,jobId,item.name,item.mime,item.sha256,item.bytes.length,item.key,expiresAt]);
   });
  }catch{throw new SandboxArtifactError('SANDBOX_ARTIFACT_UNAVAILABLE');}
  const written:string[]=[];
  try{
   for(const item of pending){await this.files.put(item.key,item.bytes);written.push(item.key);}
   await this.scope(subject,async client=>{
    for(const item of pending){
     const row=(await client.query("UPDATE sandbox_artifacts SET state='READY' WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND state='PREPARING' RETURNING id",[subject.tenantId,subject.actorId,item.id])).rows[0];
     if(!row)throw new SandboxArtifactError('SANDBOX_ARTIFACT_INTEGRITY_FAILED');
    }
   });
  }catch(error){
   for(const key of written)await this.files.remove(key).catch(()=>{});
   await this.scope(subject,async client=>{for(const item of pending)await client.query("UPDATE sandbox_artifacts SET state='FAILED' WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND state='PREPARING'",[subject.tenantId,subject.actorId,item.id]).catch(()=>{});}).catch(()=>{});
   if(error instanceof SandboxArtifactError)throw error;
   throw new SandboxArtifactError('SANDBOX_ARTIFACT_UNAVAILABLE');
  }
  return {reference:'sandbox-job:'+jobId};
 }
}
