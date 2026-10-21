import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import type {DbContext} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import type {FileStore} from '../../storage/src/files.js';
import type {Gateway} from '../../gateway/src/index.js';
import {canonical} from '../../gateway/src/index.js';
import {checkpointFactSchema} from '../../runtime/src/checkpoint.js';
import {leaseSchema} from '../../runtime/src/lease-contract.js';
import {attachmentDependenciesAllowed} from '../../attachments/src/egress.js';
import type {RenderedArtifact} from './index.js';
import {nativeArtifactDraftNotice,nativeArtifactHash,nativeArtifactReceiptSchema,nativeArtifactSpecifications,type NativeArtifactHostPort,type NativeArtifactContext,type NativeArtifactInput,type NativeArtifactClaim,type NativeArtifactReceipt,type NativeArtifactPreparation} from './native-contracts.js';

const proofSchema=z.object({version:z.literal(1),lease:leaseSchema,sessionNo:z.number().int().min(1).max(32),inputHash:z.string().regex(/^[a-f0-9]{64}$/),classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']),evidence:z.array(z.object({fact:checkpointFactSchema,state:z.string()}).strict()).max(64)}).strict();
type Row=pg.QueryResultRow;
const stamp=(v:unknown)=>new Date(v as string|Date).toISOString();
const denied=()=>({kind:'DENIED' as const,code:'NATIVE_ARTIFACT_SOURCE_CHANGED' as const});
/** Trusted host: real task/worker identity only, never an invented H5 session.
 * Nested draft dependencies are bounded and fail closed rather than omitted. */
export class NativeArtifactHost implements NativeArtifactHostPort{
 private checks=new AsyncLocalStorage<{depth:number;nodes:number}>();
 constructor(private reader:Gateway,private vault:Vault,private files:FileStore){}
 private async bounded<T>(fn:()=>Promise<T>):Promise<T>{
  const scope=this.checks.getStore();
  if(!scope)return this.checks.run({depth:0,nodes:0},()=>this.bounded(fn));
  if(scope.depth>=8||++scope.nodes>128)throw Error('NATIVE_ARTIFACT_SOURCE_LIMIT');
  scope.depth++;try{return await fn();}finally{scope.depth--;}
 }
 private metadata(r:Row,replayed=false):NativeArtifactReceipt{
  const spec=nativeArtifactSpecifications[r.format as NativeArtifactInput['format']];if(!spec)throw Error('NATIVE_ARTIFACT_METADATA');
  return nativeArtifactReceiptSchema.parse({artifact:{id:r.id,taskId:r.task_id,runId:r.run_id,format:r.format,mime:r.mime,fileName:r.file_name,byteSize:Number(r.byte_size),sha256:r.sha256,createdAt:stamp(r.created_at),source:{mode:'TOOL_DRAFT',verification:'UNVERIFIED',classification:r.classification,asOf:stamp(r.created_at),notice:nativeArtifactDraftNotice}},replayed});
 }
 private proof(p:DbContext,r:Row){
  if(r.source_mode!=='TOOL_DRAFT'||!r.source_proof)throw Error('NATIVE_ARTIFACT_PROOF');
  const text=this.vault.open(r.source_proof as Sealed,`${p.tenantId}:${p.actorId}:native-artifact:${r.id}`);
  if(hash(text)!==r.source_hash)throw Error('NATIVE_ARTIFACT_PROOF');
  const proof=proofSchema.parse(JSON.parse(text));
  if(proof.lease.runId!==r.run_id||proof.lease.taskId!==r.task_id||proof.sessionNo!==Number(r.source_session_no)||proof.inputHash!==r.request_hash||proof.classification!==r.classification||proof.lease.authEpoch!==Number(r.auth_epoch)||proof.lease.audience['kind']!=='PRIVATE_USER'||proof.lease.audience['targetId']!==p.actorId||proof.lease.groupAudience||proof.lease.nativeCaseAudience)throw Error('NATIVE_ARTIFACT_PROOF');
  return proof;
 }
 private async local(c:pg.PoolClient,p:DbContext,r:Row,lock=false){
  const proof=this.proof(p,r),lease=proof.lease;
  const row=(await c.query("SELECT a.state action_state,a.logical_action_key,a.input_ref,a.capability_id,a.tool_version,a.risk,r.status,r.fence,r.lease_owner,r.lease_until>clock_timestamp() live FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=r.owner_id JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.owner_id JOIN tenants org ON org.tenant_id=r.tenant_id JOIN tool_actions a ON a.tenant_id=r.tenant_id AND a.id=$3 AND a.run_id=r.id AND a.owner_id=r.owner_id WHERE r.id=$1 AND t.id=$2 AND r.owner_id=$4 AND r.provider_session_no=$5 AND t.auth_epoch=$6 AND u.auth_epoch=t.auth_epoch AND u.status='ACTIVE' AND org.status='ACTIVE' AND org.policy_version=$7 AND t.audience=$8::jsonb AND t.expires_at=$9::timestamptz AND t.goal=$10 AND t.status IN ('ACTIVE','COMPLETED') AND t.cancel_requested_at IS NULL AND t.expires_at>clock_timestamp() AND r.status IN ('RUNNING','SUCCEEDED','PARTIAL') AND public.oa_lifecycle_run_allowed(r.id) AND NOT public.oa_run_content_erased(r.id)"+(lock?' FOR SHARE OF r,t,u':''),[r.run_id,r.task_id,r.native_action_id,p.actorId,proof.sessionNo,lease.authEpoch,lease.policyVersion,JSON.stringify(lease.audience),lease.expiresAt,lease.goal])).rows[0];
  if(!row||row.capability_id!=='artifacts.create'||row.tool_version!=='1.0.0'||row.risk!=='READ'||!row.input_ref||nativeArtifactHash(this.reader.store.openActionInput(p,row.logical_action_key as string,row.input_ref))!==proof.inputHash)throw Error('NATIVE_ARTIFACT_AUTHORITY');
  if(row.status==='RUNNING'){
   if(!row.live||Number(row.fence)!==lease.fence||row.lease_owner!==lease.workerId||!['EXECUTING','VERIFIED'].includes(row.action_state as string))throw Error('NATIVE_ARTIFACT_AUTHORITY');
  }else if(row.action_state!=='VERIFIED')throw Error('NATIVE_ARTIFACT_AUTHORITY');
  return proof;
 }
 /** Used by cached tool evidence and the real-session download service. No
  * successful check grants access: callers recheck immediately before release. */
 async sourceAllowed(c:pg.PoolClient,p:DbContext,r:Row,signal:AbortSignal){return this.bounded(async()=>{
  signal.throwIfAborted();const proof=await this.local(c,p,r);
  if(!await this.reader.finalSourcesAllowed(p,proof.lease,c,proof.evidence,signal)||!await this.reader.store.sourceSelectionsAllowed(c,p,proof.lease,(...a)=>this.reader.finalSourcesAllowed(...a),signal)||!await attachmentDependenciesAllowed(c,p,r.task_id as string,{runId:r.run_id as string,sessionNo:proof.sessionNo}))return false;
  signal.throwIfAborted();await this.local(c,p,r);return true;
 });}
 async authorize(args:NativeArtifactInput,context:{principal:DbContext;lease:NativeArtifactContext['lease'];signal?:AbortSignal},c:pg.PoolClient,cached:unknown){
  const {principal:p,lease}=context,signal=context.signal??AbortSignal.timeout(30000);
  if(lease.audience['kind']!=='PRIVATE_USER'||lease.audience['targetId']!==p.actorId||p.auditAccess)return false;
  if(cached&&typeof cached==='object'&&(cached as {status?:unknown}).status!=='OK'&&(cached as {data?:unknown}).data===undefined){
   // Empty/UNKNOWN receipts contain no file authority. Preserve their durable
   // outcome on replay; denying this check must not turn UNKNOWN into a retry.
   return !!(await c.query("SELECT r.id FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.owner_id JOIN tenants org ON org.tenant_id=r.tenant_id WHERE r.id=$1 AND t.id=$2 AND r.owner_id=$3 AND t.requester_id=r.owner_id AND t.auth_epoch=$4 AND u.auth_epoch=t.auth_epoch AND u.status='ACTIVE' AND org.status='ACTIVE' AND org.policy_version=$5 AND t.audience=$6::jsonb AND t.expires_at=$7::timestamptz AND t.goal=$8 AND t.expires_at>clock_timestamp() AND t.cancel_requested_at IS NULL AND t.status IN ('ACTIVE','COMPLETED') AND r.status IN ('RUNNING','SUCCEEDED','PARTIAL','WAITING_USER') AND public.oa_lifecycle_run_allowed(r.id) AND NOT public.oa_run_content_erased(r.id)",[lease.runId,lease.taskId,p.actorId,lease.authEpoch,lease.policyVersion,JSON.stringify(lease.audience),lease.expiresAt,lease.goal])).rowCount;
  }
  if(cached){
   const receipt=nativeArtifactReceiptSchema.safeParse((cached as {data?:unknown}).data);if(!receipt.success)return false;
   const r=(await c.query("SELECT * FROM artifacts WHERE id=$1 AND task_id=$2 AND run_id=$3 AND state='READY' AND expires_at>clock_timestamp()",[receipt.data.artifact.id,lease.taskId,lease.runId])).rows[0];
   return !!r&&r.request_hash===nativeArtifactHash(args)&&canonical(this.metadata(r).artifact)===canonical(receipt.data.artifact)&&await this.sourceAllowed(c,p,r,signal);
  }
  await this.reader.store.guard(c,lease);signal.throwIfAborted();return true;
 }
 async prepare(context:NativeArtifactContext,args:NativeArtifactInput,inputHash:string):Promise<NativeArtifactPreparation>{
  const {principal:p,lease,signal,actionKey}=context;if(nativeArtifactHash(args)!==inputHash)return denied();
  return this.reader.store.guarded(p,lease,async c=>{
   const action=(await c.query("SELECT id FROM tool_actions WHERE logical_action_key=$1 AND run_id=$2 AND capability_id='artifacts.create' AND state='EXECUTING'",[actionKey,lease.runId])).rows[0];if(!action)return denied();
   const prior=(await c.query('SELECT * FROM artifacts WHERE native_action_id=$1 FOR UPDATE',[action.id])).rows[0];
   if(prior){if(prior.request_hash!==inputHash)return denied();if(prior.state==='READY'&&await this.sourceAllowed(c,p,prior,signal))return {kind:'REPLAY',receipt:this.metadata(prior,true)};return {kind:'UNKNOWN',code:'NATIVE_ARTIFACT_NOT_READY'};}
   if(Number((await c.query('SELECT count(*) n FROM artifacts WHERE task_id=$1',[lease.taskId])).rows[0].n)>=50)return {kind:'DENIED',code:'NATIVE_ARTIFACT_LIMIT'};
   const sources=await this.reader.snapshotToolSources(p,lease,c,actionKey,signal),proof=proofSchema.parse({version:1,lease,inputHash,...sources});
   const id=randomUUID(),storageKey=`${p.tenantId}/${p.actorId}/${id}/${randomUUID()}.sealed`,text=JSON.stringify(proof);if(Buffer.byteLength(text)>2*1024*1024)return {kind:'DENIED',code:'NATIVE_ARTIFACT_LIMIT'};
   signal.throwIfAborted();await this.reader.store.guard(c,lease);
   const r=(await c.query("INSERT INTO artifacts(tenant_id,id,owner_id,task_id,run_id,source_session_no,source_hash,auth_epoch,format,state,request_key,request_hash,storage_key,classification,expires_at,source_mode,source_proof,native_action_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PREPARING',$10,$11,$12,$13,$14,'TOOL_DRAFT',$15,$16) RETURNING *",[p.tenantId,id,p.actorId,lease.taskId,lease.runId,proof.sessionNo,hash(text),lease.authEpoch,args.format,'native:'+action.id,inputHash,storageKey,proof.classification,lease.expiresAt,JSON.stringify(this.vault.seal(text,`${p.tenantId}:${p.actorId}:native-artifact:${id}`)),action.id])).rows[0];
   const document=structuredClone(args.source.document);if(args.format==='csv')document.table!.columns[0]!.name=nativeArtifactDraftNotice+' '+document.table!.columns[0]!.name;else document.paragraphs.unshift(nativeArtifactDraftNotice);
   return {kind:'PREPARED',claim:{id,inputHash},request:{format:nativeArtifactSpecifications[args.format].format,title:document.title,paragraphs:document.paragraphs,...(document.table?{table:document.table}:{})},source:{mode:'TOOL_DRAFT',verification:'UNVERIFIED',classification:proof.classification,asOf:stamp(r.created_at),notice:nativeArtifactDraftNotice}};
  });
 }
 async publish(context:NativeArtifactContext,claim:NativeArtifactClaim,rendered:RenderedArtifact){
  const {principal:p,lease,signal}=context;
  const current=async(c:pg.PoolClient)=>{const r=(await c.query("SELECT * FROM artifacts WHERE id=$1 AND request_hash=$2 AND run_id=$3 AND state='PREPARING' AND source_mode='TOOL_DRAFT' AND expires_at>clock_timestamp()",[claim.id,claim.inputHash,lease.runId])).rows[0];if(!r||!await this.sourceAllowed(c,p,r,signal))throw Error('NATIVE_ARTIFACT_SOURCE_CHANGED');return r;};
  const r=await this.reader.store.guarded(p,lease,current),spec=nativeArtifactSpecifications[r.format as NativeArtifactInput['format']];
  if(rendered.format!==spec.format||rendered.mime!==spec.mime||rendered.extension!==spec.extension||rendered.sha256!==createHash('sha256').update(rendered.bytes).digest('hex'))return denied();
  signal.throwIfAborted();await this.files.put(r.storage_key as string,rendered.bytes);
  // A lost commit acknowledgment propagates to the adapter as UNKNOWN. Failure
  // settlement waits for the row and must never remove possibly READY bytes.
  return this.reader.store.guarded(p,lease,async c=>{
   await current(c);signal.throwIfAborted();await this.reader.store.guard(c,lease);
   const ready=(await c.query("UPDATE artifacts SET state='READY',mime=$2,file_name=$3,byte_size=$4,sha256=$5,inspection=$6,updated_at=clock_timestamp() WHERE id=$1 AND state='PREPARING' RETURNING *",[r.id,rendered.mime,`artifact-${r.id}${rendered.extension}`,rendered.bytes.length,rendered.sha256,JSON.stringify(rendered.inspection)])).rows[0];
   if(!ready)return denied();return {kind:'READY' as const,receipt:this.metadata(ready)};
  });
 }
 async settleFailure(context:NativeArtifactContext,claim:NativeArtifactClaim,failure:{stage:'RENDER'|'PUBLISH';code:string}):Promise<'FAILED_CONFIRMED'|'UNKNOWN'>{
  const p=context.principal;
  try{
   const row=await this.reader.store.db.scope(p,async c=>(await c.query("UPDATE artifacts SET state='FAILED',source_proof=NULL,last_error=$4,updated_at=clock_timestamp() WHERE id=$1 AND request_hash=$2 AND run_id=$3 AND source_mode='TOOL_DRAFT' AND state='PREPARING' AND native_action_id IN (SELECT id FROM tool_actions WHERE logical_action_key=$5) RETURNING storage_key",[claim.id,claim.inputHash,context.lease.runId,failure.code,context.actionKey])).rows[0]);
   if(!row)return 'UNKNOWN';
   const key=row.storage_key as string;if(!key.startsWith(`${p.tenantId}/${p.actorId}/${claim.id}/`))return 'UNKNOWN';
   await this.files.remove(key).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});
   await this.reader.store.db.scope(p,c=>c.query("UPDATE artifacts SET file_removed_at=clock_timestamp() WHERE id=$1 AND state='FAILED'",[claim.id]));return 'FAILED_CONFIRMED';
  }catch{return 'UNKNOWN';}
 }
}
