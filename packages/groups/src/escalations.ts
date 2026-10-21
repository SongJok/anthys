import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import type {Database} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import type {Principal} from '../../identity/src/sessions.js';
import {GroupCaseRoster} from './case-roster.js';
import {evaluateGroupContract,type GroupContract} from './contract-model.js';
import {groupContractWorkingAt} from './reminder-policy.js';
import {openRegisteredCases} from './reminder-proof.js';
import {renderGroupEscalationNotification} from './escalation-proof.js';
import {groupEscalationContext,groupEscalationContextHash,groupEscalationIntentSchema,groupEscalationIntentHash,groupEscalationPreviewSchema,groupEscalationPreviewHash,groupEscalationReferenceSchema,groupEscalationNotice,type GroupEscalationContext,type GroupEscalationIntent,type GroupEscalationHostPort,type GroupEscalationPreparation,type GroupEscalationRead,type GroupEscalationEnqueue,type GroupEscalationCancellation,type GroupEscalationReference} from './escalation-contracts.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),savedPrincipal=z.object({tenantId:uuid,actorId:uuid,sessionId:uuid,authEpoch:z.number().int().positive().safe(),roles:z.array(z.string()).max(128),auditAccess:z.literal(false).optional()}).strict();
export const groupEscalationProofSchema=z.object({schemaVersion:z.literal(1),principal:savedPrincipal,preview:groupEscalationPreviewSchema,sourceHash:sha}).strict();
export type GroupEscalationProof=z.infer<typeof groupEscalationProofSchema>;
type Row=pg.QueryResultRow;
const unknown=()=>({kind:'UNKNOWN' as const,code:'GROUP_ESCALATION_RESULT_UNKNOWN' as const});
const denied=(code:'GROUP_ESCALATION_DENIED'|'GROUP_ESCALATION_SOURCE_CHANGED'|'GROUP_ESCALATION_NOT_FOUND'|'GROUP_ESCALATION_EXPIRED'|'GROUP_ESCALATION_LIMIT'|'GROUP_ESCALATION_CANCELLED'|'GROUP_ESCALATION_INPUT_INVALID'='GROUP_ESCALATION_DENIED')=>({kind:'DENIED' as const,code});
const iso=(v:unknown)=>new Date(v as string|Date).toISOString();
function knownFailure(error:unknown){const name=error instanceof Error?error.message:'';if(/^GROUP_CASE_(?:SESSION_INVALID|NOT_FOUND|ACTION_DENIED|LIFECYCLE_BLOCKED|CONTRACT_CONFLICT|ROSTER_UNAVAILABLE|ROSTER_CHANGED|ROSTER_UNVERIFIED|NOT_MEMBER|STOPPED)$/.test(name))return denied();return ['GROUP_ESCALATION_DENIED','GROUP_ESCALATION_SOURCE_CHANGED','GROUP_ESCALATION_NOT_FOUND','GROUP_ESCALATION_EXPIRED','GROUP_ESCALATION_LIMIT','GROUP_ESCALATION_CANCELLED','GROUP_ESCALATION_INPUT_INVALID'].includes(name)?denied(name as Parameters<typeof denied>[0]):unknown();}
/** Real H5 session and current reviewed group authority. This service persists
 * consent/queue state only; it neither sends nor invents a model/run/session. */
export class GroupEscalations implements GroupEscalationHostPort{
 constructor(readonly db:Database,readonly vault:Vault,readonly roster:GroupCaseRoster,readonly robotCode:string){}
 private aad(tenant:string,id:string){return `${tenant}:group-case-escalation:${id}`;}
 async session(c:pg.PoolClient,p:Principal){
  const row=(await c.query("SELECT s.expires_at FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN tenants t ON t.tenant_id=s.tenant_id WHERE s.id=$1 AND s.owner_id=$2 AND s.auth_epoch=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.auth_epoch=s.auth_epoch AND u.status='ACTIVE' AND t.status='ACTIVE'",[p.sessionId,p.actorId,p.authEpoch])).rows[0];
  if(!row||p.auditAccess)throw Error('GROUP_ESCALATION_DENIED');return row;
 }
 async load(c:pg.PoolClient,context:GroupEscalationContext,id:string){
  await this.session(c,context.principal);const row=(await c.query('SELECT *,expires_at<=clock_timestamp() expired FROM group_case_escalations WHERE id=$1 AND group_id=$2 AND administrator_id=$3 AND session_id=$4 AND auth_epoch=$5 AND context_hash=$6',[id,context.groupId,context.principal.actorId,context.principal.sessionId,context.principal.authEpoch,groupEscalationContextHash(context)])).rows[0];
  if(!row)throw Error('GROUP_ESCALATION_NOT_FOUND');return row;
 }
 open(row:Row){
  const proof=groupEscalationProofSchema.parse(JSON.parse(this.vault.open(row.proof_ref as Sealed,this.aad(row.tenant_id as string,row.id as string))));
  const p=proof.preview;if(p.proposalId!==row.id||p.groupId!==row.group_id||p.case.id!==row.case_id||p.case.version!==Number(row.case_version)||p.contract.id!==row.contract_id||p.contract.version!==Number(row.contract_version)||p.contract.hash!==row.contract_hash||p.contextHash!==row.context_hash||p.intentHash!==row.intent_hash||groupEscalationIntentHash(p.intent)!==p.intentHash||groupEscalationPreviewHash(p)!==row.preview_hash||proof.sourceHash!==row.source_hash||iso(row.expires_at)!==p.expiresAt||proof.principal.tenantId!==row.tenant_id||proof.principal.actorId!==row.administrator_id||proof.principal.sessionId!==row.session_id||proof.principal.authEpoch!==Number(row.auth_epoch))throw Error('GROUP_ESCALATION_SOURCE_CHANGED');return proof;
 }
 private receipt(row:Row,asOf:string,replayed=false){return {proposalId:row.id as string,previewHash:row.preview_hash as string,contextHash:row.context_hash as string,groupId:row.group_id as string,caseId:row.case_id as string,caseVersion:Number(row.case_version),contractVersion:Number(row.contract_version),verification:'UNVERIFIED' as const,asOf,replayed};}
 async current(c:pg.PoolClient,context:GroupEscalationContext,intent:GroupEscalationIntent){
  context.signal.throwIfAborted();const p=context.principal,e=this.roster.evidence(c,p,context.groupId),o=e.observer;
  if(!o.authority.administrator||o.authority.contractVersion!==intent.expectedContractVersion)throw Error('GROUP_ESCALATION_DENIED');
  const row=(await c.query('SELECT r.document_ref,r.document_hash FROM group_contracts g JOIN group_contract_revisions r ON r.tenant_id=g.tenant_id AND r.id=g.current_revision_id AND r.contract_id=g.id WHERE g.id=$1 AND g.group_id=$2',[o.authority.contractId,context.groupId])).rows[0];
  if(!row||row.document_hash!==o.contractHash)throw Error('GROUP_ESCALATION_SOURCE_CHANGED');
  const text=this.vault.open(row.document_ref as Sealed,`${p.tenantId}:group-contract:${o.authority.contractId}:${o.revisionId}`);if(hash(text)!==o.contractHash)throw Error('GROUP_ESCALATION_SOURCE_CHANGED');
  const document=JSON.parse(text) as GroupContract,now=iso((await c.query('SELECT clock_timestamp() value')).rows[0].value),at=Date.parse(now);
  if(evaluateGroupContract(document,{tenantId:p.tenantId,groupId:context.groupId,contractId:o.authority.contractId,serviceIdentityId:o.identityId,currentVersion:intent.expectedContractVersion,now:at}).status!=='ELIGIBLE'||(document.sources.mode??'MENTION_ONLY')!=='MENTION_ONLY'||!document.actions.allowed.includes('case.escalate')||document.actions.prohibited.includes('case.escalate')||!groupContractWorkingAt(document,at)||(document.limits?.summariesPerGroupPerHour??6)<1)throw Error('GROUP_ESCALATION_DENIED');
  const targets=document.escalationUserIds.map(id=>{uuid.parse(id);const member=e.members.find(m=>m.id===id);if(!member)throw Error('GROUP_ESCALATION_SOURCE_CHANGED');return member;});
  if(!targets.length||targets.length>20||new Set(targets.map(t=>t.id)).size!==targets.length)throw Error('GROUP_ESCALATION_DENIED');
  const sources=openRegisteredCases((await c.query('SELECT public.oa_group_escalation_case($1,$2,$3,$4) value',[context.groupId,p.sessionId,intent.caseId,intent.expectedContractVersion])).rows[0].value,p,this.vault,context.groupId,document,this.robotCode);
  const item=sources.items[0];if(sources.items.length!==1||!item||item.version!==intent.expectedCaseVersion||!['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED'].includes(item.state)||item.state!=='BLOCKED'&&(item.dueAt===null||Date.parse(item.dueAt)>at)||item.ownerId!==null&&!e.members.some(m=>m.id===item.ownerId))throw Error('GROUP_ESCALATION_SOURCE_CHANGED');
  return {item,observer:o,targets,now,sourceHash:hash(canonical({contractHash:o.contractHash,caseSourceHash:sources.hash,rosterHash:e.hash,targets})),serviceOwnerId:o.serviceOwnerId};
 }
 private async transaction<T>(context:GroupEscalationContext,fn:(c:pg.PoolClient)=>Promise<T>,version:number|null=null,observe=true){
  context.signal.throwIfAborted();return this.db.scope(context.principal,async c=>{await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='12s'");const value=observe?await this.roster.guard(c,context.principal,context.groupId,'case.escalate',version,context.signal,()=>fn(c)):await fn(c);context.signal.throwIfAborted();return value;});
 }
 private async state(c:pg.PoolClient,context:GroupEscalationContext,row:Row):Promise<GroupEscalationRead>{
  // This is a read of an already persisted state, never a fresh enqueue receipt.
  const now=iso((await c.query('SELECT clock_timestamp() value')).rows[0].value),receipt=this.receipt(row,now,true);
  if(row.state==='CANCELLED')return {kind:'CANCELLED_LOCAL',receipt};
  if(['CLAIMED','UNKNOWN','APPLIED_UNVERIFIED','FAILED','SUPPRESSED'].includes(row.state as string)||row.state==='QUEUED'&&Date.parse(iso(row.expires_at))<=Date.parse(now))return {kind:'DELIVERY_STATUS',receipt,delivery:(await c.query('SELECT public.oa_group_escalation_receipt($1,$2) value',[row.id,context.principal.sessionId])).rows[0].value};
  if(Date.parse(iso(row.expires_at))<=Date.parse(now))return denied('GROUP_ESCALATION_EXPIRED');
  const proof=this.open(row),source=await this.current(c,context,proof.preview.intent);if(source.sourceHash!==proof.sourceHash||source.serviceOwnerId!==row.service_owner_id)throw Error('GROUP_ESCALATION_SOURCE_CHANGED');
  if(row.state==='QUEUED')return {kind:'QUEUED',receipt};return {kind:'PREPARED',preview:proof.preview,previewHash:row.preview_hash as string};
 }
 async prepare(raw:GroupEscalationContext,rawIntent:GroupEscalationIntent,requestId:string):Promise<GroupEscalationPreparation>{try{
  const context=groupEscalationContext(raw),intent=groupEscalationIntentSchema.parse(rawIntent);uuid.parse(requestId);
  return await this.transaction(context,async c=>{
   const s=await this.current(c,context,intent),id=randomUUID(),p=context.principal,preview=groupEscalationPreviewSchema.parse({proposalId:id,contextHash:groupEscalationContextHash(context),intent,intentHash:groupEscalationIntentHash(intent),groupId:context.groupId,case:{id:s.item.id,version:s.item.version,title:s.item.title,resourceRef:s.item.resourceRef,state:s.item.state,ownerId:s.item.ownerId,dueAt:s.item.dueAt},contract:{id:s.observer.authority.contractId,version:s.observer.authority.contractVersion,hash:s.observer.contractHash},targets:s.targets,coverage:{mode:'MENTION_ONLY',completeChat:false},verification:'UNVERIFIED',asOf:s.now,expiresAt:new Date(Math.min(Date.parse(s.now)+60000,Date.parse(s.observer.contractExpiresAt),Date.parse(s.observer.scopeExpiresAt),Date.parse(s.observer.sessionExpiresAt))).toISOString(),notice:groupEscalationNotice}),proof=groupEscalationProofSchema.parse({schemaVersion:1,principal:p,preview,sourceHash:s.sourceHash});
   renderGroupEscalationNotification(preview);
   const row=(await c.query('SELECT public.oa_group_escalation_prepare($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) value',[context.groupId,p.sessionId,id,requestId,preview.intentHash,preview.contextHash,intent.caseId,intent.expectedCaseVersion,intent.expectedContractVersion,groupEscalationPreviewHash(preview),s.sourceHash,JSON.stringify(this.vault.seal(canonical(proof),this.aad(p.tenantId,id))),preview.expiresAt])).rows[0].value as Row;
   const result=await this.state(c,context,row);return result.kind==='PREPARED'||result.kind==='DENIED'||result.kind==='UNKNOWN'?result:unknown();
  },intent.expectedContractVersion);
 }catch(error){return knownFailure(error);}}
 async read(raw:GroupEscalationContext,proposalId:string):Promise<GroupEscalationRead>{try{
  const context=groupEscalationContext(raw);uuid.parse(proposalId);
  const persisted=await this.transaction(context,async c=>{const row=await this.load(c,context,proposalId);return ['PREPARED','QUEUED'].includes(row.state as string)&&!(row.state==='QUEUED'&&row.expired===true)?null:this.state(c,context,row);},null,false);
  return persisted??await this.transaction(context,async c=>this.state(c,context,await this.load(c,context,proposalId)));
 }catch(error){return knownFailure(error);}}
 /** Revalidate a previously authenticated, sealed H5 approval against that real
  * session and current DB/remote authority; this never creates a session. */
 async verifyPersisted(proof:GroupEscalationProof,signal:AbortSignal){
  const saved=proof.principal,principal:Principal={tenantId:saved.tenantId,actorId:saved.actorId,sessionId:saved.sessionId,authEpoch:saved.authEpoch,roles:saved.roles,...(saved.auditAccess===false?{auditAccess:false}:{})};
  const context=groupEscalationContext({principal,groupId:proof.preview.groupId,signal});
  if(groupEscalationContextHash(context)!==proof.preview.contextHash)return false;
  try{return await this.transaction(context,async c=>(await this.current(c,context,proof.preview.intent)).sourceHash===proof.sourceHash,proof.preview.contract.version);}catch{return false;}
 }
 async enqueue(raw:GroupEscalationContext,rawRef:GroupEscalationReference,requestId:string):Promise<GroupEscalationEnqueue>{try{
  const context=groupEscalationContext(raw),ref=groupEscalationReferenceSchema.parse(rawRef);uuid.parse(requestId);
  return await this.transaction(context,async c=>{const before=await this.load(c,context,ref.proposalId);if(before.preview_hash!==ref.previewHash)return denied('GROUP_ESCALATION_SOURCE_CHANGED');const current=await this.state(c,context,before);if(current.kind==='DENIED'||current.kind==='UNKNOWN')return current;if(current.kind!=='PREPARED'&&current.kind!=='QUEUED')return unknown();const row=(await c.query('SELECT public.oa_group_escalation_confirm($1,$2,$3,$4,$5) value',[context.groupId,context.principal.sessionId,ref.proposalId,ref.previewHash,requestId])).rows[0].value as Row;if(row.state!=='QUEUED')return unknown();return {kind:'QUEUED',receipt:this.receipt(row,iso((await c.query('SELECT clock_timestamp() value')).rows[0].value),Boolean(row.replayed))};});
 }catch(error){return knownFailure(error);}}
 async cancel(raw:GroupEscalationContext,rawRef:GroupEscalationReference,requestId:string):Promise<GroupEscalationCancellation>{try{
  const context=groupEscalationContext(raw),ref=groupEscalationReferenceSchema.parse(rawRef);uuid.parse(requestId);
  return await this.transaction(context,async c=>{await this.load(c,context,ref.proposalId);const row=(await c.query('SELECT public.oa_group_escalation_cancel($1,$2,$3,$4,$5) value',[context.groupId,context.principal.sessionId,ref.proposalId,ref.previewHash,requestId])).rows[0].value as Row;return {kind:row.state==='CANCELLED'?'CANCELLED_LOCAL':'RECONCILE_REQUIRED',receipt:this.receipt(row,iso((await c.query('SELECT clock_timestamp() value')).rows[0].value),Boolean(row.replayed))};},null,false);
 }catch(error){return knownFailure(error);}}
}
