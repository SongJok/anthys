import {NativeArtifactHost} from './native-host.js';
import {nativeArtifactDraftNotice} from './native-contracts.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import type {Database,DbContext} from '../../storage/src/database.js';
import type {Principal} from '../../identity/src/sessions.js';
import {Vault,hash} from '../../storage/src/crypto.js';
import type {FileStore} from '../../storage/src/files.js';
import type {Gateway} from '../../gateway/src/index.js';
import {finalResultAllowed} from '../../gateway/src/final-delivery.js';
import {renderArtifact,ArtifactFailure,type ArtifactOptions} from './index.js';
import {taskResultArtifactRequest} from './task-result.js';
import {artifactCreateInput,artifactMetadata,artifactSourceNotice,ArtifactAccessError,type ArtifactMetadata} from './contracts.js';
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const instant=(v:unknown)=>new Date(v as string|Date).toISOString();
const checkpoint=(signal?:AbortSignal)=>{if(signal?.aborted)fail('ARTIFACT_CANCELLED',409);};
const formats={md:['text/markdown; charset=utf-8','.md'],txt:['text/plain; charset=utf-8','.txt'],csv:['text/csv; charset=utf-8','.csv'],json:['application/json','.json'],html:['text/html; charset=utf-8','.html'],xlsx:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx'],docx:['application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],pdf:['application/pdf','.pdf']} as const;
const fail=(code='ARTIFACT_ACCESS_DENIED',status:ArtifactAccessError['status']=404):never=>{throw new ArtifactAccessError(code,status);};
type Row=pg.QueryResultRow;
/** Local rendering only. Current source access is independently re-established
 * before rendering, publication, ticket issue and final file release. */
export class TaskResultArtifacts{
 constructor(private db:Database,private vault:Vault,private files:FileStore,private reader:Gateway|undefined,private fonts:Pick<ArtifactOptions,'pdfFont'|'docxFont'>={}){}
 private scope<T>(p:DbContext,fn:(c:pg.PoolClient)=>Promise<T>){return this.db.scope(p,async c=>{await c.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','3000',true)");return fn(c);});}
 private async session(c:pg.PoolClient,p:Principal){
  const row=(await c.query("SELECT s.id FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN tenants t ON t.tenant_id=s.tenant_id WHERE s.id=$1 AND s.owner_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_epoch=$3 AND u.auth_epoch=s.auth_epoch AND u.status='ACTIVE' AND t.status='ACTIVE'",[p.sessionId,p.actorId,p.authEpoch])).rows[0];
  if(!row)fail('ARTIFACT_SESSION_EXPIRED',401);
 }
 private async source(c:pg.PoolClient,p:Principal,taskId:string,runId:string,pin?:Row,signal?:AbortSignal){
  checkpoint(signal);
  await this.session(c,p);const reader=this.reader;if(!reader)return fail('ARTIFACT_SOURCE_READER_UNCONFIGURED',503);
  if(pin?.source_mode==='TOOL_DRAFT'){
   const host=new NativeArtifactHost(reader,this.vault,this.files),activeSignal=signal??AbortSignal.timeout(30000);
   const final=async(lock=false)=>(await c.query("SELECT r.* FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.id=$1 AND t.id=$2 AND r.owner_id=$3 AND t.requester_id=r.owner_id AND t.status IN ('ACTIVE','COMPLETED') AND t.cancel_requested_at IS NULL AND t.expires_at>clock_timestamp() AND t.auth_epoch=$4 AND EXISTS(SELECT 1 FROM users u JOIN tenants org ON org.tenant_id=u.tenant_id WHERE u.tenant_id=r.tenant_id AND u.id=r.owner_id AND u.auth_epoch=t.auth_epoch AND u.status='ACTIVE' AND org.status='ACTIVE') AND public.oa_lifecycle_run_allowed(r.id) AND NOT public.oa_run_content_erased(r.id) AND r.status IN ('SUCCEEDED','PARTIAL') AND r.result IS NOT NULL"+(lock?' FOR SHARE OF r,t':''),[runId,taskId,p.actorId,p.authEpoch])).rows[0];
   const before=await final();if(!before||!await host.sourceAllowed(c,p,pin,activeSignal)||!await finalResultAllowed(c,p,this.vault,runId,before.result as string,(...a)=>reader.finalSourcesAllowed(...a)))fail('ARTIFACT_SOURCE_UNVERIFIED',409);
   checkpoint(signal);await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`${p.tenantId.toLowerCase()}:memory:${p.actorId.toLowerCase()}`]);
   const after=await final(true);if(!after||JSON.stringify(before)!==JSON.stringify(after))fail();await this.session(c,p);checkpoint(signal);return after;
  }
  const local=async(lock=false)=>(await c.query("SELECT r.id,r.task_id,r.result,r.result_classification,r.provider_session_no,t.goal,t.auth_epoch,t.expires_at,t.audience,org.policy_version FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=r.owner_id JOIN tenants org ON org.tenant_id=t.tenant_id WHERE r.id=$1 AND t.id=$2 AND r.owner_id=$3 AND t.auth_epoch=$4 AND r.status IN ('SUCCEEDED','PARTIAL') AND t.status IN ('ACTIVE','COMPLETED') AND t.cancel_requested_at IS NULL AND t.expires_at>clock_timestamp() AND r.result IS NOT NULL AND public.oa_lifecycle_run_allowed(r.id) AND NOT public.oa_run_content_erased(r.id)"+(lock?' FOR SHARE OF r,t':''),[runId,taskId,p.actorId,p.authEpoch])).rows[0];
  const r=await local();
  if(!r||typeof r.result!=='string'||!r.result.trim())fail();
  if(pin&&(hash(r.result)!==pin.source_hash||String(r.provider_session_no)!==String(pin.source_session_no)||String(r.auth_epoch)!==String(pin.auth_epoch)||r.result_classification!==pin.classification))fail();
  if(!await finalResultAllowed(c,p,this.vault,runId,r.result,(ctx,lease,client,evidence)=>reader.finalSourcesAllowed(ctx,lease,client,evidence,signal)))fail('ARTIFACT_SOURCE_UNVERIFIED',409);
  // Network/source checks above hold no local artifact row or erasure lock.
  // Re-observe after them and keep the existing erasure barrier only across
  // the final local checks and publication/read transaction.
  checkpoint(signal);await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`${p.tenantId.toLowerCase()}:memory:${p.actorId.toLowerCase()}`]);
  const after=await local(true);if(!after||JSON.stringify(after)!==JSON.stringify(r))fail();
  await this.session(c,p);checkpoint(signal);return after;
 }
 private metadata(r:Row):ArtifactMetadata{
  const format=artifactCreateInput.shape.format.parse(r.format),spec=formats[format];
  if(r.mime!==spec[0]||r.file_name!==`artifact-${r.id}${spec[1]}`)fail('ARTIFACT_INTEGRITY_FAILED',503);
  return artifactMetadata.parse({id:r.id,taskId:r.task_id,runId:r.run_id,format,mime:r.mime,fileName:r.file_name,byteSize:Number(r.byte_size),sha256:r.sha256,createdAt:instant(r.created_at),source:{mode:r.source_mode==='TOOL_DRAFT'?'TOOL_DRAFT':'VERIFIED_TASK_RESULT',classification:r.classification,verification:r.source_verification,asOf:instant(r.created_at),notice:r.source_mode==='TOOL_DRAFT'?nativeArtifactDraftNotice:artifactSourceNotice}});
 }
 private async current(c:pg.PoolClient,p:Principal,id:string,signal?:AbortSignal){
  checkpoint(signal);
  const r=(await c.query("SELECT * FROM artifacts WHERE id=$1 AND state='READY' AND expires_at>clock_timestamp()",[id])).rows[0];if(!r)fail();
  await this.source(c,p,r.task_id as string,r.run_id as string,r,signal);const latest=(await c.query("SELECT * FROM artifacts WHERE id=$1 AND state='READY' AND expires_at>clock_timestamp()",[id])).rows[0];if(!latest||JSON.stringify(latest)!==JSON.stringify(r))fail();this.metadata(latest);return latest;
 }
 async list(p:Principal,taskId:string,signal:AbortSignal=AbortSignal.timeout(30000)){
  checkpoint(signal);
  z.uuid().parse(taskId);const rows=await this.scope(p,async c=>{
   await this.session(c,p);if(!(await c.query('SELECT id FROM tasks WHERE id=$1 AND requester_id=$2',[taskId,p.actorId])).rowCount)fail();
   return (await c.query("SELECT id FROM artifacts WHERE task_id=$1 AND state='READY' AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 1000",[taskId])).rows;
  });
  const items:ArtifactMetadata[]=[];for(const r of rows)try{items.push(await this.scope(p,async c=>this.metadata(await this.current(c,p,r.id as string,signal))));}catch(e){if(!(e instanceof ArtifactAccessError)||e.status===401)throw e;}
  const asOf=await this.scope(p,async c=>{await this.session(c,p);return instant((await c.query('SELECT clock_timestamp() stamp')).rows[0].stamp);});checkpoint(signal);return {items,asOf};
 }
 async create(p:Principal,taskId:string,raw:unknown,key:string,signal:AbortSignal){
  z.uuid().parse(taskId);const input=artifactCreateInput.parse(raw);z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/).parse(key);signal.throwIfAborted();
  const requestHash=hash(JSON.stringify(input)),id=randomUUID(),storageKey=`${p.tenantId}/${p.actorId}/${id}/${randomUUID()}.sealed`;
  const claim=await this.scope(p,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.tenantId}:${p.actorId}:artifacts:${taskId}`]);
   const prior=(await c.query('SELECT * FROM artifacts WHERE task_id=$1 AND request_key=$2',[taskId,key])).rows[0];
   if(prior){if(prior.request_hash!==requestHash)fail('IDEMPOTENCY_CONFLICT',409);await this.source(c,p,taskId,input.runId,prior,signal);if(prior.state!=='READY'||new Date(prior.expires_at as Date).getTime()<=Date.now())fail('ARTIFACT_NOT_READY',409);return {replayed:true as const,artifact:this.metadata(prior)};}
   const source=await this.source(c,p,taskId,input.runId,undefined,signal);
   if(Number((await c.query('SELECT count(*) n FROM artifacts WHERE task_id=$1',[taskId])).rows[0].n)>=50)fail('ARTIFACT_TASK_LIMIT',429);
   const row=(await c.query("INSERT INTO artifacts(tenant_id,id,owner_id,task_id,run_id,source_session_no,source_hash,auth_epoch,format,state,request_key,request_hash,storage_key,classification,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PREPARING',$10,$11,$12,$13,$14) RETURNING *",[p.tenantId,id,p.actorId,taskId,input.runId,source.provider_session_no,hash(source.result as string),p.authEpoch,input.format,key,requestHash,storageKey,source.result_classification,source.expires_at])).rows[0];
   return {replayed:false as const,row,source};
  });
  if(claim.replayed)return claim;
  try{
   signal.throwIfAborted();const rendered=await renderArtifact(taskResultArtifactRequest({format:input.format,title:claim.source.goal,result:claim.source.result,source:{verification:'UNVERIFIED',asOf:instant(claim.row.created_at),notice:artifactSourceNotice}}),{...this.fonts,signal});
   if(rendered.mime!==formats[input.format][0]||rendered.extension!==formats[input.format][1]||digest(rendered.bytes)!==rendered.sha256)fail('ARTIFACT_INTEGRITY_FAILED',503);
   await this.scope(p,c=>this.source(c,p,taskId,input.runId,claim.row,signal));signal.throwIfAborted();await this.files.put(storageKey,rendered.bytes);
   const artifact=await this.scope(p,async c=>{
    await this.source(c,p,taskId,input.runId,claim.row,signal);signal.throwIfAborted();
    const row=(await c.query("UPDATE artifacts SET state='READY',mime=$2,file_name=$3,byte_size=$4,sha256=$5,inspection=$6,updated_at=clock_timestamp() WHERE id=$1 AND state='PREPARING' AND expires_at>clock_timestamp() RETURNING *",[id,rendered.mime,`artifact-${id}${rendered.extension}`,rendered.bytes.length,rendered.sha256,JSON.stringify(rendered.inspection)])).rows[0];if(!row)fail('ARTIFACT_PUBLICATION_REVOKED',409);return this.metadata(row);
   });return {artifact,replayed:false};
  }catch(error){
   // The exact storage key is retained for bounded cleanup if unlink fails.
   // A failed COMMIT response can conceal a committed READY row. Preserve its
   // bytes until persisted state is known; never erase a possibly published file.
   const claimed=await this.scope(p,async c=>(await c.query("UPDATE artifacts SET state='FAILED',last_error=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='PREPARING' AND storage_key=$3 RETURNING id",[id,error instanceof ArtifactFailure?error.code:'ARTIFACT_GENERATION_FAILED',storageKey])).rowCount===1).catch(()=>false);
   // UPDATE waits for any unresolved publisher row lock. Its predicate is
   // re-evaluated after that transaction commits: READY means no unlink.
   if(claimed){const removed=await this.files.remove(storageKey).then(()=>true,e=>(e as NodeJS.ErrnoException).code==='ENOENT');if(removed)await this.scope(p,c=>c.query("UPDATE artifacts SET file_removed_at=clock_timestamp() WHERE id=$1 AND state IN ('FAILED','REVOKED')",[id])).catch(()=>{});}
   if(error instanceof ArtifactAccessError)throw error;if(error instanceof ArtifactFailure)fail(error.code,422);if(signal.aborted)fail('ARTIFACT_CANCELLED',409);return fail('ARTIFACT_GENERATION_FAILED',503);
  }
 }
 async ticket(p:Principal,id:string,signal:AbortSignal=AbortSignal.timeout(30000)){
  checkpoint(signal);
  z.uuid().parse(id);const token=randomBytes(32).toString('base64url');return this.scope(p,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.tenantId}:${p.actorId}:artifact-ticket:${id}`]);
   const row=await this.current(c,p,id,signal);checkpoint(signal);
   const pending=Number((await c.query('SELECT count(*) n FROM artifact_download_tickets WHERE artifact_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',[id])).rows[0].n);if(pending>=10)fail('ARTIFACT_TICKET_LIMIT',429);
   const t=(await c.query("INSERT INTO artifact_download_tickets(tenant_id,id,owner_id,artifact_id,session_id,token_hash,artifact_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,least(clock_timestamp()+interval '30 seconds',$8::timestamptz)) RETURNING expires_at",[p.tenantId,randomUUID(),p.actorId,id,p.sessionId,hash(token),row.sha256,row.expires_at])).rows[0];
   checkpoint(signal);return {ticket:token,expiresAt:instant(t.expires_at),artifactId:id,sha256:row.sha256 as string,byteSize:Number(row.byte_size)};
  });
 }
 async download(p:Principal,id:string,token:string,signal:AbortSignal){
  z.uuid().parse(id);z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(token);signal.throwIfAborted();
  const row=await this.scope(p,async c=>{
   const r=await this.current(c,p,id,signal);
   const ticket=await c.query('UPDATE artifact_download_tickets SET consumed_at=clock_timestamp() WHERE artifact_id=$1 AND session_id=$2 AND token_hash=$3 AND artifact_hash=$4 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id',[id,p.sessionId,hash(token),r.sha256]);if(!ticket.rowCount)fail('ARTIFACT_TICKET_INVALID',403);return r;
  });
  if(!(row.storage_key as string).startsWith(`${p.tenantId}/${p.actorId}/${id}/`))fail('ARTIFACT_INTEGRITY_FAILED',503);
  const bytes=await this.files.get(row.storage_key as string);signal.throwIfAborted();if(bytes.length!==Number(row.byte_size)||digest(bytes)!==row.sha256)fail('ARTIFACT_INTEGRITY_FAILED',503);
  await this.scope(p,async c=>{const current=await this.current(c,p,id,signal);if(current.sha256!==row.sha256||current.storage_key!==row.storage_key)fail();if(!(await c.query('SELECT id FROM artifact_download_tickets WHERE artifact_id=$1 AND session_id=$2 AND token_hash=$3 AND artifact_hash=$4 AND consumed_at IS NOT NULL AND expires_at>clock_timestamp()',[id,p.sessionId,hash(token),row.sha256])).rowCount)fail('ARTIFACT_TICKET_EXPIRED',403);});signal.throwIfAborted();return {bytes,metadata:this.metadata(row)};
 }
 /** Bounded private-file repair. Access checks deny erased/revoked sources
  * immediately, independently of successful eventual physical unlink. */
 async maintain(scope:DbContext,limit=64){
  z.number().int().min(1).max(128).parse(limit);
  const rows=await this.scope(scope,async c=>{
   await c.query("DELETE FROM artifact_download_tickets WHERE id IN (SELECT id FROM artifact_download_tickets WHERE expires_at<=clock_timestamp()-interval '1 day' ORDER BY expires_at,id LIMIT 128 FOR UPDATE SKIP LOCKED)");
   return (await c.query("UPDATE artifacts a SET state='REVOKED',source_proof=CASE WHEN source_mode='TOOL_DRAFT' THEN NULL ELSE source_proof END,updated_at=clock_timestamp() WHERE a.id IN (SELECT id FROM artifacts WHERE (file_removed_at IS NULL OR source_proof IS NOT NULL AND source_mode='TOOL_DRAFT') AND (source_mode='TOOL_DRAFT' AND NOT EXISTS(SELECT 1 FROM tool_actions a WHERE a.id=artifacts.native_action_id AND a.run_id=artifacts.run_id AND a.state IN ('EXECUTING','VERIFIED','UNKNOWN')) OR state IN ('FAILED','REVOKED') OR state='PREPARING' AND created_at<clock_timestamp()-interval '5 minutes' OR expires_at<=clock_timestamp() OR public.oa_run_content_erased(run_id) OR NOT EXISTS(SELECT 1 FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN tenants org ON org.tenant_id=t.tenant_id WHERE r.id=artifacts.run_id AND r.task_id=artifacts.task_id AND (artifacts.source_mode='TOOL_DRAFT' OR r.result IS NOT NULL) AND r.provider_session_no=artifacts.source_session_no AND t.auth_epoch=artifacts.auth_epoch AND u.auth_epoch=t.auth_epoch AND u.status='ACTIVE' AND org.status='ACTIVE' AND t.cancel_requested_at IS NULL AND t.status IN ('ACTIVE','COMPLETED') AND (r.status IN ('SUCCEEDED','PARTIAL') OR artifacts.source_mode='TOOL_DRAFT' AND r.status IN ('RUNNING','WAITING_USER')))) ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id,storage_key",[limit])).rows;
  });
  let removed=0;for(const r of rows){const id=z.uuid().parse(r.id),key=r.storage_key as string;if(!key.startsWith(`${scope.tenantId}/${scope.actorId}/${id}/`))fail('ARTIFACT_INTEGRITY_FAILED',503);await this.files.remove(key).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});await this.scope(scope,c=>c.query("UPDATE artifacts SET file_removed_at=clock_timestamp() WHERE id=$1 AND state='REVOKED'",[id]));removed++;}
  return {removed,more:rows.length===limit};
 }
}
