import {snapshotToolSources} from './source-snapshot.js';
import {isGroupCaseRead} from '../../groups/src/read-capability.js';
import {isGroupCompanyAgent} from '../../company/src/agent-group-capability.js';
import {isCertifiedGroupRead,certifiedGroupReadSurface} from './group-read-surface.js';
import {capabilityDescriptorSchema,type CapabilityDescriptor} from '../../contracts/src/capability.js';
import {z} from 'zod';
import {parseCapabilityResult,CapabilityOutputError} from '../../contracts/src/result-contract.js';
import {createHash,randomUUID} from 'node:crypto';
import type {ZodType} from 'zod';
import {hash} from '../../storage/src/crypto.js';
import type {DbContext} from '../../storage/src/database.js';
import {type ToolResult,blocked} from '../../contracts/src/index.js';
import type {ModelTool} from '../../provider-glm/src/client.js';
import type {RuntimeStore,Lease,FinalOutcome} from '../../runtime/src/store.js';
import {authorize} from '../../policy/src/index.js';
import type pg from 'pg';
import {contextAllowed,contextAllowedForLease} from './context.js';
import type {ProviderMessage} from '../../provider-glm/src/sse.js';
import type {RebuildReason} from '../../runtime/src/checkpoint.js';
import {draftCheckpoint} from './checkpoint.js';
import {killed} from './controls.js';
import {finalEvidenceAllowed,type FinalEvidence} from './finalizer.js';
import {type ChoiceProjection} from '../../runtime/src/source-choice.js';
export function canonical(value:unknown):string {
 if(value===null||typeof value!=='object') {const s=JSON.stringify(value);if(s===undefined) throw Error('UNHASHABLE');return s;}
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}
/** Internal control result, never a provider wire payload or model fact. */
export type DeferredExecution=Omit<ToolResult,'status'>&{status:'DEFERRED';requestId:string};
export interface Capability extends Omit<CapabilityDescriptor,'inputSchema'|'supportsVerify'> {
 connectorId?:string;
 resultSchema:ZodType;
 schema:ZodType;jsonSchema:Record<string,unknown>;bindingHash:string;
 resource:(args:unknown,lease:Lease)=>string;
 execute:(args:unknown,context:{principal:DbContext;lease:Lease;signal:AbortSignal;actionKey:string})=>Promise<ToolResult|DeferredExecution>;
 allowResource?:(args:unknown,context:{principal:DbContext;lease:Lease;signal?:AbortSignal},db:pg.PoolClient,cached:unknown)=>Promise<boolean>;
 retainFact?:(args:unknown,context:{principal:DbContext;lease:Lease},db:pg.PoolClient,result:ToolResult)=>Promise<void>;
 approvalPreview?:(args:unknown,lease:Lease)=>Record<string,unknown>;
 operationAudience?:(args:unknown,lease:Lease)=>Record<string,unknown>;
 protectResult?:boolean;
 classifyResult?:(result:ToolResult)=>'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED';
 retryableRead?:boolean;
 deferredExecution?:boolean;
 sourceChoices?:{version:string;project:(result:ToolResult)=>ChoiceProjection};
 verify?:(result:ToolResult,args:unknown,context:{principal:DbContext;lease:Lease;signal:AbortSignal})=>Promise<ToolResult>;
}
export const toolName=(id:string,version:string)=>'cap_'+createHash('sha256').update(`${id}@${version}`).digest('hex').slice(0,12);
export function legacyActionArgumentsHash(ctx:DbContext,lease:Lease,c:Capability,resource:string,args:unknown):string{return hash(canonical({capability:c.id,version:c.version,bindingHash:c.bindingHash,actor:{tenantId:ctx.tenantId,actorId:ctx.actorId},resource,args,audience:lease.audience,authEpoch:lease.authEpoch,policyVersion:lease.policyVersion}));}
export function capabilityDescriptor(c:Capability):CapabilityDescriptor{return capabilityDescriptorSchema.parse({id:c.id,version:c.version,description:c.description,provider:c.provider,inputSchema:c.jsonSchema,outputSchema:c.outputSchema,authModes:c.authModes,risk:c.risk,requiredPermissions:c.requiredPermissions,supportsIdempotency:c.supportsIdempotency,supportsDryRun:c.supportsDryRun,supportsVerify:typeof c.verify==='function',state:c.state,bindingRef:c.bindingRef});}
export function capabilityDescriptorHash(c:Capability):string{return hash(canonical(capabilityDescriptor(c)));}
class CapabilitySnapshotChanged extends Error {constructor(){super('CAPABILITY_CHANGED');}}
const invocationCallbacks=(c:Capability)=>[c.schema,c.resultSchema,c.resource,c.execute,c.allowResource,c.retainFact,c.approvalPreview,c.operationAudience,c.verify,c.classifyResult,c.sourceChoices?.project];
function invocationContractHash(c:Capability){return hash(canonical({descriptor:capabilityDescriptor(c),bindingHash:c.bindingHash,connector:c.connectorId??c.provider,protectResult:c.protectResult===true,retryableRead:c.retryableRead===true,deferredExecution:c.deferredExecution===true,sourceChoicesVersion:c.sourceChoices?.version??null}));}
export function actionScope(ctx:DbContext,lease:Lease,c:Capability,resource:string,args:unknown){return {version:2,capability:c.id,semanticVersion:c.version,bindingHash:c.bindingHash,descriptorHash:capabilityDescriptorHash(c),risk:c.risk,connector:c.connectorId??c.provider,actor:{tenantId:ctx.tenantId,actorId:ctx.actorId},resource,argsHash:hash(canonical(args)),audience:lease.audience,operationAudience:c.operationAudience?.(args,lease)??null,expiresAt:lease.expiresAt,authEpoch:lease.authEpoch,policyVersion:lease.policyVersion,previewHash:hash(canonical(c.approvalPreview?.(args,lease)??null))};}
export function actionArgumentsHash(ctx:DbContext,lease:Lease,c:Capability,resource:string,args:unknown):string{return c.risk==='READ'?legacyActionArgumentsHash(ctx,lease,c,resource,args):hash(canonical(actionScope(ctx,lease,c,resource,args)));}
export class Gateway {
 private registry=new Map<string,Capability>();
 constructor(readonly store:RuntimeStore) {}
 register(c:Capability):void {const key=toolName(c.id,c.version);if(this.registry.has(key)) throw Error('DUPLICATE_CAPABILITY');if(!c.resultSchema||!c.outputSchema||canonical(z.toJSONSchema(c.resultSchema))!==canonical(c.outputSchema))throw Error('CAPABILITY_OUTPUT_CONTRACT_REQUIRED');this.contract(c);if(c.supportsDryRun)throw Error('CAPABILITY_DRY_RUN_EXECUTOR_UNAVAILABLE');this.registry.set(key,c);}
 private contract(c:Capability):CapabilityDescriptor{return capabilityDescriptor(c);}
 // Internal configuration inspection; no public discovery or permission grant.
 describeContract(id:string,version:string):CapabilityDescriptor|null{const c=this.registry.get(toolName(id,version));return c?structuredClone(this.contract(c)):null;}
 describeCapability(id:string,version:string){const c=this.registry.get(toolName(id,version));return c?{id:c.id,version:c.version,bindingHash:c.bindingHash,inputSchemaHash:hash(canonical(c.jsonSchema)),outputSchemaHash:hash(canonical(c.outputSchema)),descriptorHash:hash(canonical(this.contract(c))),provider:c.provider,risk:c.risk,state:c.state,authModes:[...c.authModes]}:null;}
 async prepareAudience(ctx:DbContext,lease:Lease,signal:AbortSignal){if(lease.audience['kind']!=='GROUP')return true;if(this.store.nativeCaseAudiences&&(await this.store.db.scope(ctx,async c=>(await c.query("SELECT control_kind FROM tasks WHERE id=$1",[lease.taskId])).rows[0]?.control_kind))==='GROUP_CASE'){try{if(lease.groupAudience)return false;lease.nativeCaseAudience=await this.store.nativeCaseAudiences.issue(ctx,lease,c=>this.store.guard(c,lease),signal);return true;}catch{signal.throwIfAborted();return false;}}if(!this.store.groupAudiences)return false;try{if(lease.groupAudience)return this.store.db.scope(ctx,c=>this.store.groupAudienceAllowed(c,ctx,lease,signal));lease.groupAudience=await this.store.groupAudiences.issue(ctx,lease,c=>this.store.guard(c,lease),signal);return true;}catch{signal.throwIfAborted();return false;}}
 async preparePersonas(ctx:DbContext,lease:Lease,signal:AbortSignal){if(lease.personaSnapshot)return this.store.db.scope(ctx,c=>this.store.personaAllowed(c,ctx,lease,signal));const state=await this.store.db.scope(ctx,async c=>(await c.query('SELECT persona_context_state FROM runs WHERE id=$1',[lease.runId])).rows[0]?.persona_context_state);if(state==='LEGACY_NONE'||state==='BUILTIN_ONLY')return true;if(!this.store.personae)return false;try{lease.personaSnapshot=await this.store.personae.issue(ctx,lease,c=>this.store.guard(c,lease),(...a)=>this.store.groupAudienceAllowed(...a),signal);return true;}catch{signal.throwIfAborted();return false;}}
 async finalize(ctx:DbContext,lease:Lease,proposal:string,repair=false):Promise<FinalOutcome>{return this.store.finish(ctx,lease,proposal,this.registry,repair);}
 async finalSourcesAllowed(ctx:DbContext,lease:Lease,c:pg.PoolClient,evidence:FinalEvidence[],signal?:AbortSignal):Promise<boolean>{if(!await this.store.personaAllowed(c,ctx,lease,signal)||!await this.store.groupAudienceAllowed(c,ctx,lease,signal)||lease.audience['kind']==='GROUP'&&!(evidence.every(e=>isGroupCaseRead(this.registry.get(e.fact.name)))||evidence.every(e=>isGroupCompanyAgent(this.registry.get(e.fact.name)))))return false;if(lease.audience['kind']==='GROUP'&&(await c.query("SELECT control_kind FROM tasks WHERE id=$1",[lease.taskId])).rows[0]?.control_kind==='GROUP_CASE')return evidence.length===0&&await this.store.nativeCaseProjectionAllowed(c,ctx,lease);for(const proof of evidence)if(!await finalEvidenceAllowed(this.store,this.registry,ctx,lease,c,proof,signal))return false;return true;}
 async snapshotToolSources(ctx:DbContext,lease:Lease,c:pg.PoolClient,currentActionKey:string,signal:AbortSignal){return snapshotToolSources(this.store,this.registry,ctx,lease,c,currentActionKey,signal);}
 async finalResultAllowed(ctx:DbContext,runId:string,result:string):Promise<boolean>{return this.store.finalResultAllowed(ctx,runId,result,(...args)=>this.finalSourcesAllowed(...args));}
 async processGroupReply(ctx:DbContext,id:string,generation=0,signal?:AbortSignal){return this.store.processGroupReply(ctx,id,generation,signal);}
 async processSourceReply(ctx:DbContext,id:string,generation=0,signal?:AbortSignal){return this.store.processSourceReply(ctx,id,async(principal,lease,c,evidence,activeSignal)=>await this.finalSourcesAllowed(principal,lease,c,evidence,activeSignal)&&await this.store.sourceSelectionsAllowed(c,principal,lease,(...a)=>this.finalSourcesAllowed(...a),activeSignal),(...a)=>this.choiceTargetAllowed(...a),generation,signal);}
 async choiceTargetAllowed(ctx:DbContext,lease:Lease,c:pg.PoolClient,p:ChoiceProjection,index:number,signal?:AbortSignal):Promise<boolean>{
  const lifecycle=await trialState(c,lease.runId);if(lifecycle.restricted&&(lifecycle.mode!=='FORMAL'||!lifecycle.allowed||!lifecycle.capabilities?.some(a=>a.id===p.next.id&&a.version===p.next.version&&a.bindingHash===p.next.bindingHash)))return false;
  const target=this.registry.get(toolName(p.next.id,p.next.version)),option=p.options[index-1];if(!target||!option||target.risk!=='READ'||target.state!=='READY'||target.bindingHash!==p.next.bindingHash)return false;const parsed=target.schema.safeParse(option.args);if(!parsed.success||canonical(parsed.data)!==canonical(option.args)||await killed(c,ctx,lease,target.connectorId??target.provider,false))return false;
  const resource=target.resource(parsed.data,lease),binding=target.provider==='CORE'?{rowCount:1}:await c.query("SELECT id FROM capability_bindings WHERE logical_id=$1 AND semantic_version=$2 AND schema_hash=$3 AND risk='READ' AND state='READY'",[target.id,target.version,target.bindingHash]);if(!binding.rowCount)return false;
  if(target.provider==='CORE'){if(resource!==lease.taskId||lease.audience['kind']!=='PRIVATE_USER'||lease.audience['targetId']!==ctx.actorId)return false;}else if(!(await c.query("SELECT id FROM resource_grants WHERE capability_id=$1 AND resource_id=$2 AND actor_id=$3 AND audience_kind='PRIVATE_USER' AND audience_id=$3::uuid::text AND revoked_at IS NULL AND expires_at>clock_timestamp() AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,$4,$5,$6,$7))",[target.id,resource,ctx.actorId,target.version,target.bindingHash,hash(canonical(target.jsonSchema)),capabilityDescriptorHash(target)])).rowCount)return false;
  const usage=(await c.query('SELECT tool_calls,budget FROM runs WHERE id=$1',[lease.runId])).rows[0];if(Number(usage.tool_calls)>=Number(usage.budget.maxTools)&&!(await c.query("SELECT id FROM tool_actions WHERE run_id=$1 AND capability_id=$2 AND args_hash=$3 AND state='VERIFIED'",[lease.runId,target.id,actionArgumentsHash(ctx,lease,target,resource,parsed.data)])).rowCount)return false;
  return !target.allowResource||await target.allowResource(parsed.data,{principal:ctx,lease,...(signal?{signal}:{})},c,undefined);
 }
 private async groupReadSurface(ctx:DbContext,lease:Lease,history:ProviderMessage[],db?:pg.PoolClient):Promise<boolean>{const check=async(c:pg.PoolClient)=>!(await c.query('SELECT id FROM attachments WHERE task_id=$1 LIMIT 1',[lease.taskId])).rowCount&&certifiedGroupReadSurface(this.registry,history,(await c.query('SELECT * FROM tool_actions WHERE run_id=$1',[lease.runId])).rows);return db?check(db):this.store.db.scope(ctx,check);}
 async loadContext(ctx:DbContext,lease:Lease){const current=await this.store.historyState(ctx,lease);if(lease.audience['kind']==='GROUP'&&!await this.groupReadSurface(ctx,lease,current.messages)){await this.store.pause(ctx,lease,'PARTIAL','GROUP_RESOURCE_SHARING_UNCERTIFIED');return {messages:[],blocked:true};}return current.expired?this.rebuildContext(ctx,lease,'JOURNAL_EXPIRED'):{messages:current.messages,blocked:false};}
 async rebuildContext(ctx:DbContext,lease:Lease,reason:RebuildReason,history:ProviderMessage[]=[]){return this.store.guarded(ctx,lease,async db=>{if(lease.audience['kind']==='GROUP'&&!await this.groupReadSurface(ctx,lease,history,db)){await db.query("UPDATE runs SET status='PARTIAL',last_error='GROUP_RESOURCE_SHARING_UNCERTIFIED',lease_until=NULL WHERE id=$1",[lease.runId]);return {messages:[],blocked:true};}if(!await this.store.sourceSelectionsAllowed(db,ctx,lease,(...a)=>this.finalSourcesAllowed(...a))){await db.query("UPDATE runs SET status='PARTIAL',last_error='SOURCE_CHOICE_SOURCE_CHANGED',lease_until=NULL WHERE id=$1",[lease.runId]);return {messages:[],blocked:true};}const draft=await draftCheckpoint(this.store,this.registry,ctx,lease,db,history);return this.store.commitContext(db,ctx,lease,reason,draft,async facts=>{for(const fact of facts)await this.registry.get(fact.name)?.retainFact?.(fact.args,{principal:ctx,lease},db,fact.result);});});}
 async contextAllowed(ctx:DbContext,lease:Lease,history:ProviderMessage[]):Promise<boolean>{return contextAllowed(this.store,this.registry,ctx,lease,history);}
 async modelDispatchReason(ctx:DbContext,lease:Lease,history:ProviderMessage[],db:pg.PoolClient,signal?:AbortSignal):Promise<string|null>{if(!await this.store.personaContextAllowed(db,ctx,lease,history,signal)||!await this.store.groupAudienceAllowed(db,ctx,lease,signal))return 'MODEL_CONTEXT_CHANGED_BEFORE_DISPATCH';if(await killed(db,ctx,lease,'GLM',false))return 'MODEL_KILL_SWITCH';if(!await this.store.clarificationContextAllowed(db,ctx,lease)||!await this.store.sourceSelectionsAllowed(db,ctx,lease,(...a)=>this.finalSourcesAllowed(...a),signal))return 'MODEL_CONTEXT_CHANGED_BEFORE_DISPATCH';const pending=await this.store.pendingSourceSelection(db,ctx,lease);if(pending&&!await this.choiceTargetAllowed(ctx,lease,db,pending.projection,pending.index,signal))return 'MODEL_CONTEXT_CHANGED_BEFORE_DISPATCH';return await contextAllowedForLease(this.store,this.registry,ctx,lease,history,db)?null:'MODEL_CONTEXT_CHANGED_BEFORE_DISPATCH';}
 async modelAllowed(ctx:DbContext,lease:Lease):Promise<boolean>{return this.store.guarded(ctx,lease,async db=>!await killed(db,ctx,lease,'GLM',false));}
 async tools(ctx:DbContext,lease:Lease):Promise<ModelTool[]> {
  const lifecycle=await this.store.db.scope(ctx,c=>trialState(c,lease.runId));if(lifecycle.restricted&&(lifecycle.mode!=='FORMAL'||!lifecycle.allowed))return [];
  return this.store.guarded(ctx,lease,async db=>{
   const result:ModelTool[]=[];if(!await this.store.personaAllowed(db,ctx,lease))return result;if(lease.audience['kind']!=='GROUP'&&(lease.audience['kind']!=='PRIVATE_USER'||lease.audience['targetId']!==ctx.actorId))return result;if(!await this.store.groupAudienceAllowed(db,ctx,lease))return result;
   const pending=await this.store.pendingSourceSelection(db,ctx,lease);
   for(const [name,c] of this.registry) {
    if(lease.audience['kind']==='GROUP'){if(!isCertifiedGroupRead(c)||!this.store.groupAudiences)continue;try{if(isGroupCaseRead(c)){if(!this.store.groupCases)continue;await this.store.groupCases.modelReadAllowed(db,ctx,lease,this.store.groupAudiences);}else if(!c.allowResource||!await c.allowResource({message:lease.goal},{principal:ctx,lease},db,null))continue;}catch{continue;}}else if(isCertifiedGroupRead(c))continue;
    if(lifecycle.mode==='FORMAL'&&!lifecycle.capabilities?.some(a=>a.id===c.id&&a.version===c.version&&a.bindingHash===c.bindingHash))continue;
    if(pending&&(c.id!==pending.projection.next.id||c.version!==pending.projection.next.version||c.bindingHash!==pending.projection.next.bindingHash))continue;
    if(c.state!=='READY'||c.risk==='FORBIDDEN'||await killed(db,ctx,lease,c.connectorId??c.provider,c.risk!=='READ'))continue;
    if(c.provider!=='CORE') {
     const binding=await db.query("SELECT id FROM capability_bindings WHERE logical_id=$1 AND semantic_version=$2 AND schema_hash=$3 AND risk=$4 AND state='READY'",[c.id,c.version,c.bindingHash,c.risk]);
     if(!binding.rowCount)continue;
     const grants=await db.query('SELECT audience_kind,audience_id,membership_version FROM resource_grants WHERE actor_id=$1 AND capability_id=$2 AND revoked_at IS NULL AND expires_at>now() AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,$3,$4,$5,$6))',[ctx.actorId,c.id,c.version,c.bindingHash,hash(canonical(c.jsonSchema)),capabilityDescriptorHash(c)]);
     if(!grants.rows.some(g=>g.audience_kind==='PRIVATE_USER'&&g.audience_id===ctx.actorId))continue;
    }
    result.push({type:'function',function:{name,description:c.description,parameters:c.jsonSchema}});if(result.length===24)break;
   }
   return result;
  });
 }
 async resumeApproved(ctx:DbContext,lease:Lease,signal:AbortSignal):Promise<boolean>{
  const row=await this.store.guarded(ctx,lease,async db=>{const q=await db.query('SELECT a.* FROM runs r JOIN tool_actions a ON a.tenant_id=r.tenant_id AND a.id=r.resume_action_id AND a.run_id=r.id WHERE r.id=$1 AND r.resume_kind=\'APPROVED_ACTION\'',[ lease.runId]);return q.rows[0];});
  if(!row)return false;
  const historyState=await this.store.historyState(ctx,lease);if(!historyState.expired)await this.store.guarded(ctx,lease,db=>this.store.currentCheckpoint(db,ctx,lease));
  const cap=this.registry.get(toolName(row.capability_id as string,row.tool_version as string));if(!cap){await this.store.pause(ctx,lease,'WAITING_USER','APPROVED_CAPABILITY_UNAVAILABLE');return true;}
  const args=this.store.openActionInput(ctx,row.logical_action_key as string,row.input_ref);let scopeMatches=false;try{scopeMatches=actionArgumentsHash(ctx,lease,cap,row.resource_id as string,args)===row.args_hash;}catch{/* Invalid current metadata cannot inherit historical approval. */}if(!scopeMatches){await this.store.pause(ctx,lease,'WAITING_USER','APPROVED_SCOPE_CHANGED');return true;}
  const result=await this.execute(ctx,lease,toolName(cap.id,cap.version),args,signal);
  if(result.status!=='OK'){await this.store.pause(ctx,lease,result.status==='NEEDS_APPROVAL'?'WAITING_APPROVAL':'WAITING_USER',result.remediation?.kind??'APPROVED_ACTION_NOT_VERIFIED');return true;}
  // Leave the resume pointer durable until a fresh checkpoint commits. A crash
  // here reuses the action receipt and cannot repeat a committed write.
  const rebuilt=await this.rebuildContext(ctx,lease,historyState.expired?'JOURNAL_EXPIRED':'AUTHORIZATION_CHANGED',historyState.messages);if(rebuilt.blocked)return true;
  await this.store.guarded(ctx,lease,db=>db.query('UPDATE runs SET resume_action_id=NULL,resume_kind=NULL,reset_context=false WHERE id=$1',[lease.runId]));return false;
 }
 async execute(ctx:DbContext,lease:Lease,name:string,args:unknown,signal:AbortSignal):Promise<ToolResult|DeferredExecution> {
  const lifecycle=await this.store.db.scope(ctx,c=>trialState(c,lease.runId));if(lifecycle.restricted&&(lifecycle.mode!=='FORMAL'||!lifecycle.allowed))return blocked('DENIED',lifecycle.mode==='FORMAL'?'FORMAL_RUN_NOT_ADMITTED':'TRIAL_TOOLS_DISABLED');
  const registered=this.registry.get(name);if(!registered||registered.state!=='READY') return blocked('DENIED','UNREGISTERED_CAPABILITY');
  // Pin declared values and callback identities across awaits. In particular,
  // a later risk downgrade must never reclassify an uncertain write as a read.
  const c:Capability={...registered};let contractHash:string;try{contractHash=invocationContractHash(c);}catch{return blocked('DENIED','CAPABILITY_DESCRIPTOR_INVALID');}
  const callbacks=invocationCallbacks(c);
  const groupRead=lease.audience['kind']==='GROUP'&&isCertifiedGroupRead(registered);if(groupRead)signal.throwIfAborted();
  if(lease.audience['kind']==='GROUP'&&!groupRead)return this.store.guarded(ctx,lease,async db=>blocked('DENIED',await killed(db,ctx,lease,c.connectorId??c.provider,c.risk!=='READ')?'KILL_SWITCH':'GROUP_RESOURCE_SHARING_UNCERTIFIED'));
  if(lifecycle.mode==='FORMAL'&&!lifecycle.capabilities?.some(a=>a.id===c.id&&a.version===c.version&&a.bindingHash===c.bindingHash))return blocked('DENIED','FORMAL_CAPABILITY_NOT_APPROVED');
  if(isCertifiedGroupRead(registered)&&!groupRead)return blocked('DENIED','GROUP_CASE_GROUP_REQUIRED');
  const parsed=c.schema.safeParse(args);if(!parsed.success) return blocked('PERMANENT_ERROR','INVALID_ARGUMENTS');
  if(c.risk!=='READ'&&c.risk!=='FORBIDDEN'&&(!c.approvalPreview||!c.operationAudience))return blocked('DENIED','WRITE_SCOPE_UNREVIEWED');
  const resource=c.resource(parsed.data,lease),argsHash=actionArgumentsHash(ctx,lease,c,resource,parsed.data),actionKey=`${lease.runId}:${c.id}:${argsHash}`,executionAttempt=randomUUID();
  const unchanged=()=>{try{return invocationContractHash(registered)===contractHash&&invocationCallbacks(registered).every((value,index)=>value===callbacks[index])&&c.resource(parsed.data,lease)===resource&&(c.risk==='READ'||actionArgumentsHash(ctx,lease,c,resource,parsed.data)===argsHash);}catch{return false;}};
  const prepare=async(db:pg.PoolClient)=>{
   if(groupRead&&!await this.groupReadSurface(ctx,lease,await this.store.historyInTransaction(db,ctx,lease),db))return blocked('DENIED','GROUP_RESOURCE_SHARING_UNCERTIFIED');
   if(!await this.store.personaAllowed(db,ctx,lease,signal))return blocked('DENIED','PERSONA_CONTEXT_UNAVAILABLE');
   if(!await this.store.sourceSelectionsAllowed(db,ctx,lease,(...a)=>this.finalSourcesAllowed(...a),signal))return blocked('DENIED','SOURCE_CHOICE_SOURCE_CHANGED');const selected=await this.store.pendingSourceSelection(db,ctx,lease);if(selected&&(c.id!==selected.projection.next.id||c.version!==selected.projection.next.version||c.bindingHash!==selected.projection.next.bindingHash||canonical(parsed.data)!==canonical(selected.projection.options[selected.index-1]!.args)))return blocked('DENIED','SOURCE_CHOICE_TARGET_MISMATCH');
   if(c.risk!=='READ'){const legacy=await db.query("SELECT id FROM tool_actions WHERE run_id=$1 AND (hash_version=1 OR hash_version=2 AND (jsonb_typeof(scope_descriptor->'descriptorHash') IS DISTINCT FROM 'string' OR coalesce(scope_descriptor->>'descriptorHash','') !~ '^[a-f0-9]{64}$')) AND (capability_id=$2 OR starts_with(logical_action_key,$3)) LIMIT 1",[lease.runId,c.id,`${lease.runId}:${c.id}:`]);if(legacy.rowCount)return blocked('UNKNOWN','LEGACY_WRITE_REVIEW_REQUIRED');}
   const saveScope=async()=>{await db.query('UPDATE tool_actions SET hash_version=$2,scope_descriptor=$3,approval_preview=$4,connector_id=$5 WHERE logical_action_key=$1',[actionKey,c.risk==='READ'?1:2,c.risk==='READ'?null:JSON.stringify(actionScope(ctx,lease,c,resource,parsed.data)),c.risk==='READ'?null:JSON.stringify(c.approvalPreview!(parsed.data,lease)),c.connectorId??c.provider]);};
   const old=await db.query('SELECT state,result,args_hash FROM tool_actions WHERE logical_action_key=$1 FOR UPDATE',[actionKey]);
   if(c.risk!=='READ'&&!['VERIFIED','FAILED','APPLIED_UNVERIFIED'].includes(old.rows[0]?.state as string)){const unresolved=await db.query("SELECT id FROM tool_actions WHERE run_id=$1 AND logical_action_key<>$2 AND (state='UNKNOWN' OR state='EXECUTING' AND risk IS DISTINCT FROM 'READ') LIMIT 1",[lease.runId,actionKey]);if(unresolved.rowCount)return blocked('UNKNOWN','RECONCILIATION_REQUIRED');}
   let cached:unknown=old.rows[0]?.result,cachedUnreadable=false;try{if(c.protectResult&&cached)cached=this.store.openToolResult(ctx,actionKey,cached);}catch{cachedUnreadable=true;}
   if(old.rowCount) {
    if(old.rows[0].args_hash!==argsHash) return blocked('DENIED','ACTION_HASH_MISMATCH');
   }
   const provenance=[c.id,c.bindingHash,c.risk,resource,JSON.stringify(this.store.sealActionInput(ctx,actionKey,parsed.data)),lease.authEpoch,lease.policyVersion,JSON.stringify(lease.audience)];
   const run=await db.query("SELECT r.tool_calls,($4::boolean AND EXISTS(SELECT 1 FROM tool_actions a WHERE a.run_id=r.id AND a.capability_id=$2 AND a.tool_version=$3 AND (a.state IN ('APPROVAL_REQUIRED','APPROVED') OR a.risk IN ('PERSONAL_WRITE','SHARED_WRITE','SENSITIVE','FORBIDDEN') OR a.scope_descriptor->>'risk' IN ('PERSONAL_WRITE','SHARED_WRITE','SENSITIVE','FORBIDDEN')))) AS prior_write_contract FROM runs r WHERE r.id=$1",[lease.runId,c.id,c.version,c.risk==='READ']);
   // A new call is definitely not dispatched here. Preserve any prior UNKNOWN
   // outcome; a risk rename cannot turn the same recorded write into a read.
   if(run.rows[0].prior_write_contract)return blocked('DENIED','WRITE_CONTRACT_CHANGED_TO_READ');
   const grants=await db.query('SELECT audience_kind,audience_id,membership_version FROM resource_grants WHERE actor_id=$1 AND capability_id=$2 AND resource_id=$3 AND revoked_at IS NULL AND expires_at>now() AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,$4,$5,$6,$7))',[ctx.actorId,c.id,resource,c.version,c.bindingHash,hash(canonical(c.jsonSchema)),capabilityDescriptorHash(c)]);
   const groupAllowed=groupRead&&await this.store.groupAudienceAllowed(db,ctx,lease,signal)&&(!isGroupCompanyAgent(registered)||!!c.allowResource&&await c.allowResource(parsed.data,{principal:ctx,lease,signal},db,null));
   const privateAllowed=groupAllowed||c.provider==='CORE'&&resource===lease.taskId||grants.rows.some(g=>g.audience_kind==='PRIVATE_USER'&&g.audience_id===ctx.actorId);
   const destination=c.operationAudience?.(parsed.data,lease);const operationAudienceAllowed=c.risk==='READ'||!!destination&&(destination['kind']==='PRIVATE_USER'&&destination['targetId']===ctx.actorId||destination['kind']==='GROUP'&&grants.rows.some(g=>g.audience_kind==='GROUP'&&g.audience_id===destination['targetId']&&Number(g.membership_version)===destination['membershipVersion']));
   const audienceAllowed=operationAudienceAllowed&&(groupAllowed||lease.audience['kind']==='PRIVATE_USER'&&lease.audience['targetId']===ctx.actorId||grants.rows.some(g=>g.audience_kind==='GROUP'&&g.audience_id===lease.audience['targetId']&&Number(g.membership_version)===lease.audience['membershipVersion']));
   const binding=c.provider==='CORE'?{rowCount:1}:await db.query("SELECT id FROM capability_bindings WHERE logical_id=$1 AND semantic_version=$2 AND schema_hash=$3 AND risk=$4 AND state='READY'",[c.id,c.version,c.bindingHash,c.risk]);
   const approver=old.rowCount?await db.query("SELECT a.id FROM approvals a WHERE a.action_id IN (SELECT id FROM tool_actions WHERE logical_action_key=$1) AND a.args_hash=$2 AND a.state='APPROVED' AND a.workflow_version=1 AND a.expires_at>now() AND a.approver_id<>$3 AND a.requester_auth_epoch=$4 AND public.oa_control_session(a.approver_id,a.decided_session_id) AND (public.oa_control_action_authority(a.approver_id,'ACTION_APPROVER',a.action_id)->>'id')=a.authority_id::text AND (public.oa_control_action_authority(a.approver_id,'ACTION_APPROVER',a.action_id)->>'version')::bigint=a.authority_version AND (public.oa_control_action_authority(a.approver_id,'ACTION_APPROVER',a.action_id)->>'authEpoch')::bigint=a.approver_auth_epoch FOR UPDATE OF a",[actionKey,argsHash,ctx.actorId,lease.authEpoch]):{rowCount:0,rows:[]};
   const decision=authorize({identityActive:true,epochMatches:true,notCancelled:true,notExpired:true,killSwitch:await killed(db,ctx,lease,c.connectorId??c.provider,c.risk!=='READ',c.operationAudience?.(parsed.data,lease)),appReady:!!binding.rowCount,platformPermission:!!binding.rowCount,delegationValid:privateAllowed,resourceAllowed:privateAllowed,audienceAllowed,budgetAvailable:!!old.rowCount&&['VERIFIED','FAILED','APPLIED_UNVERIFIED','UNKNOWN','EXECUTING'].includes(old.rows[0].state as string)||Number(run.rows[0].tool_calls)<lease.maxTools,approvalValid:!!approver.rowCount||!!old.rowCount&&['VERIFIED','FAILED','APPLIED_UNVERIFIED','UNKNOWN','EXECUTING'].includes(old.rows[0].state as string),risk:c.risk});
   if(!decision.allowed) {
    if(decision.reason==='APPROVAL_REQUIRED') {if(old.rows[0]?.state==='APPROVED'){await db.query("UPDATE approvals SET state=CASE WHEN expires_at<=now() THEN 'EXPIRED' ELSE 'INVALIDATED' END,version=version+1 WHERE action_id IN (SELECT id FROM tool_actions WHERE logical_action_key=$1) AND state='APPROVED'",[actionKey]);await db.query("UPDATE tool_actions SET state='APPROVAL_REQUIRED',version=version+1 WHERE logical_action_key=$1 AND state='APPROVED'",[actionKey]);}await db.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version,capability_id,binding_hash,risk,resource_id,input_ref,execution_auth_epoch,execution_policy_version,execution_audience) VALUES($1,$2,$3,$4,$5,$6,'APPROVAL_REQUIRED',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING",[ctx.tenantId,randomUUID(),ctx.actorId,lease.runId,actionKey,argsHash,c.provider,c.version,...provenance]);await saveScope();return blocked('NEEDS_APPROVAL','APPROVAL_REQUIRED');}
    return blocked('DENIED',decision.reason);
   }
   if(cachedUnreadable||cached!=null||old.rowCount&&['VERIFIED','FAILED','APPLIED_UNVERIFIED'].includes(old.rows[0].state as string)){try{if(cachedUnreadable)throw new CapabilityOutputError();cached=parseCapabilityResult(c,cached);}catch{return blocked(c.risk==='READ'?'PERMANENT_ERROR':'UNKNOWN',c.risk==='READ'?'CACHED_OUTPUT_CONTRACT_INVALID':'RECONCILIATION_REQUIRED');}}
   if(c.allowResource&&!await c.allowResource(parsed.data,{principal:ctx,lease,signal},db,cached))return blocked('DENIED','RESOURCE_SOURCE_OR_EGRESS_DENIED');
   if(old.rowCount && ['VERIFIED','FAILED','APPLIED_UNVERIFIED'].includes(old.rows[0].state as string)){let result:ToolResult;try{result=parseCapabilityResult(c,cached);}catch{return blocked(c.risk==='READ'?'PERMANENT_ERROR':'UNKNOWN',c.risk==='READ'?'CACHED_OUTPUT_CONTRACT_INVALID':'RECONCILIATION_REQUIRED');}if(result.status==='OK'){await c.retainFact?.(parsed.data,{principal:ctx,lease},db,result);await this.store.consumeSourceSelection(db,lease,actionKey);}return result;}
   if(old.rowCount && ['EXECUTING','UNKNOWN'].includes(old.rows[0].state as string)) return blocked('UNKNOWN','RECONCILIATION_REQUIRED');
   const claim=await db.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version,retry_safety,execution_attempt_id,capability_id,binding_hash,risk,resource_id,input_ref,execution_auth_epoch,execution_policy_version,execution_audience) VALUES($1,$2,$3,$4,$5,$6,'EXECUTING',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(tenant_id,logical_action_key) DO UPDATE SET state='EXECUTING',retry_safety=excluded.retry_safety,execution_attempt_id=excluded.execution_attempt_id,capability_id=excluded.capability_id,binding_hash=excluded.binding_hash,risk=excluded.risk,resource_id=excluded.resource_id,input_ref=excluded.input_ref,execution_auth_epoch=excluded.execution_auth_epoch,execution_policy_version=excluded.execution_policy_version,execution_audience=excluded.execution_audience WHERE tool_actions.state IN ('PREPARED','APPROVAL_REQUIRED','APPROVED') RETURNING id",[ctx.tenantId,randomUUID(),ctx.actorId,lease.runId,actionKey,argsHash,c.provider,c.version,c.risk==='READ'&&c.retryableRead?'CERTIFIED_READ':'UNKNOWN',executionAttempt,...provenance]);
   if(!claim.rowCount) return blocked('UNKNOWN','ACTION_ALREADY_CLAIMED');await saveScope();
   if(approver.rowCount) await db.query("UPDATE approvals SET state='CONSUMED',consumed_attempt_id=$2,version=version+1 WHERE id=$1",[approver.rows[0].id,executionAttempt]);
   const quota=await db.query('UPDATE runs SET tool_calls=tool_calls+1 WHERE id=$1 AND tool_calls<$2 RETURNING id',[lease.runId,lease.maxTools]);if(!quota.rowCount)throw Error('TOOL_QUOTA_RESERVATION_LOST');return null;
  };
  let prepared:ToolResult|null;
  try{prepared=await this.store.guarded(ctx,lease,async db=>{if(!unchanged())throw new CapabilitySnapshotChanged();const outcome=await prepare(db);if(!unchanged())throw new CapabilitySnapshotChanged();return outcome;});}
  catch(error){if(error instanceof CapabilitySnapshotChanged)return blocked('DENIED','CAPABILITY_CHANGED_BEFORE_CLAIM');throw error;}
  if(prepared) return prepared;
  let result:ToolResult;
  const deferredContract=c.id==='company.agent.ask'&&c.provider==='MCP'&&c.risk==='READ'&&!c.retryableRead&&c.protectResult===true&&c.deferredExecution===true;
  const durableDeferred=async(requestId?:string):Promise<DeferredExecution|null>=>{
   if(!deferredContract)return null;
   const row=await this.store.db.scope(ctx,async db=>(await db.query("SELECT q.id FROM company_agent_requests q JOIN runs r ON r.tenant_id=q.tenant_id AND r.id=q.run_id JOIN tool_actions a ON a.tenant_id=q.tenant_id AND a.id=q.action_id WHERE q.run_id=$1 AND q.action_key=$2 AND q.execution_attempt_id=$3 AND ($4::uuid IS NULL OR q.id=$4) AND a.logical_action_key=q.action_key AND a.execution_attempt_id=q.execution_attempt_id AND a.retry_safety='UNKNOWN'",[lease.runId,actionKey,executionAttempt,requestId??null])).rows[0]);
   return row?{status:'DEFERRED',requestId:row.id as string,evidenceIds:[],completeness:'UNKNOWN'}:null;
  };
  try {signal.throwIfAborted();await this.store.guarded(ctx,lease,async db=>{if(!unchanged())throw new CapabilitySnapshotChanged();if(await killed(db,ctx,lease,c.connectorId??c.provider,c.risk!=='READ',c.operationAudience?.(parsed.data,lease)))throw Error('KILL_SWITCH');if(c.risk!=='READ'){if((await db.query("SELECT id FROM tool_actions WHERE run_id=$1 AND logical_action_key<>$2 AND (state='UNKNOWN' OR state='EXECUTING' AND risk IS DISTINCT FROM 'READ') LIMIT 1",[lease.runId,actionKey])).rowCount)throw Error('UNRESOLVED_WRITE_BEFORE_DISPATCH');const approval=await db.query("SELECT id FROM approvals a WHERE a.action_id IN (SELECT id FROM tool_actions WHERE logical_action_key=$1) AND a.state='CONSUMED' AND a.consumed_attempt_id=$2 AND a.args_hash=$3 AND a.expires_at>now() AND public.oa_control_session(a.approver_id,a.decided_session_id) AND (public.oa_control_action_authority(a.approver_id,'ACTION_APPROVER',a.action_id)->>'id')=a.authority_id::text AND (public.oa_control_action_authority(a.approver_id,'ACTION_APPROVER',a.action_id)->>'version')::bigint=a.authority_version",[actionKey,executionAttempt,argsHash]);if(!approval.rowCount)throw Error('APPROVAL_AUTHORITY_CHANGED');}if(!await this.store.sourceSelectionsAllowed(db,ctx,lease,(...a)=>this.finalSourcesAllowed(...a),signal))throw Error('SOURCE_SELECTION_CHANGED_BEFORE_DISPATCH');const currentBinding=c.provider==='CORE'?true:!!(await db.query("SELECT id FROM capability_bindings WHERE logical_id=$1 AND semantic_version=$2 AND schema_hash=$3 AND risk=$4 AND state='READY'",[c.id,c.version,c.bindingHash,c.risk])).rowCount;if(!currentBinding)throw Error('BINDING_CHANGED_BEFORE_DISPATCH');
   const currentGrants=(await db.query('SELECT audience_kind,audience_id,membership_version FROM resource_grants WHERE actor_id=$1 AND capability_id=$2 AND resource_id=$3 AND revoked_at IS NULL AND expires_at>now() AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,$4,$5,$6,$7))',[ctx.actorId,c.id,resource,c.version,c.bindingHash,hash(canonical(c.jsonSchema)),capabilityDescriptorHash(c)])).rows;
   if(!(groupRead&&await this.store.groupAudienceAllowed(db,ctx,lease,signal)&&(!isGroupCompanyAgent(registered)||!!c.allowResource&&await c.allowResource(parsed.data,{principal:ctx,lease,signal},db,null))||c.provider==='CORE'&&resource===lease.taskId||currentGrants.some(g=>g.audience_kind==='PRIVATE_USER'&&g.audience_id===ctx.actorId)))throw Error('RESOURCE_CHANGED_BEFORE_DISPATCH');
   for(const audience of [lease.audience,c.operationAudience?.(parsed.data,lease)].filter(Boolean) as Record<string,unknown>[]){if(!(groupRead&&audience===lease.audience&&await this.store.groupAudienceAllowed(db,ctx,lease,signal)&&(!isGroupCompanyAgent(registered)||!!c.allowResource&&await c.allowResource(parsed.data,{principal:ctx,lease,signal},db,null))||audience['kind']==='PRIVATE_USER'&&audience['targetId']===ctx.actorId||currentGrants.some(g=>g.audience_kind==='GROUP'&&audience['kind']==='GROUP'&&g.audience_id===audience['targetId']&&Number(g.membership_version)===audience['membershipVersion'])))throw Error('AUDIENCE_CHANGED_BEFORE_DISPATCH');}
   if(c.risk!=='READ'&&actionArgumentsHash(ctx,lease,c,resource,parsed.data)!==argsHash)throw Error('SCOPE_CHANGED_BEFORE_DISPATCH');if(c.allowResource&&!await c.allowResource(parsed.data,{principal:ctx,lease,signal},db,null))throw Error('RESOURCE_SOURCE_CHANGED_BEFORE_DISPATCH');
   if(!await this.store.sourceSelectionsAllowed(db,ctx,lease,(...a)=>this.finalSourcesAllowed(...a),signal))throw Error('SOURCE_SELECTION_CHANGED_AFTER_TARGET_CHECK');
   if(!unchanged())throw new CapabilitySnapshotChanged();await db.query('UPDATE tool_actions SET dispatch_started_at=now() WHERE logical_action_key=$1 AND execution_attempt_id=$2',[actionKey,executionAttempt]);});signal.throwIfAborted();if(!unchanged())throw new CapabilitySnapshotChanged();const execution=await c.execute(parsed.data,{principal:ctx,lease,signal,actionKey});if(!unchanged())throw new CapabilitySnapshotChanged();
   if(execution.status==='DEFERRED'){
    if(!deferredContract||!z.uuid().safeParse(execution.requestId).success)throw new CapabilityOutputError();
    const durable=await durableDeferred(execution.requestId);if(!durable)throw new CapabilityOutputError();return durable;
   }
   result=parseCapabilityResult(c,execution);if(!unchanged())throw new CapabilitySnapshotChanged();if(c.risk!=='READ'&&result.status==='OK') result=c.verify?parseCapabilityResult(c,await c.verify(result,parsed.data,{principal:ctx,lease,signal})): {...result,verification:{state:'UNVERIFIED',method:'NO_READ_BACK_AVAILABLE'}};if(!unchanged())throw new CapabilitySnapshotChanged();}
  catch(error) {
   // An enqueue COMMIT can have succeeded before its reply/continuation failed.
   // Preserve the same durable attempt; an exception cannot certify NOT_SENT.
   const durable=await durableDeferred();if(durable)return durable;
   result=deferredContract?blocked('UNKNOWN','ENTERPRISE_REQUEST_RECONCILIATION_REQUIRED'):blocked(c.risk==='READ'?error instanceof CapabilityOutputError?'PERMANENT_ERROR':'RETRYABLE_ERROR':'UNKNOWN',c.risk==='READ'?error instanceof CapabilityOutputError?'CAPABILITY_OUTPUT_INVALID':'PROVIDER_FAILED':'RECONCILIATION_REQUIRED');
  }
  if(result.status==='OK')try{await this.store.guarded(ctx,lease,async db=>{if(!unchanged())throw new CapabilitySnapshotChanged();if(!await this.store.sourceSelectionsAllowed(db,ctx,lease,(...a)=>this.finalSourcesAllowed(...a),signal))throw Error('SOURCE_CHOICE_CHANGED_BEFORE_RETENTION');if(groupRead&&(!c.allowResource||!await c.allowResource(parsed.data,{principal:ctx,lease,signal},db,result)))throw Error('GROUP_CASE_SOURCE_CHANGED_AFTER_READ');await c.retainFact?.(parsed.data,{principal:ctx,lease},db,result);if(!unchanged())throw new CapabilitySnapshotChanged();if(!await this.store.sourceSelectionsAllowed(db,ctx,lease,(...a)=>this.finalSourcesAllowed(...a),signal))throw Error('SOURCE_CHOICE_CHANGED_AFTER_RETENTION');if(!unchanged())throw new CapabilitySnapshotChanged();});}catch{result=blocked(c.risk==='READ'?'RETRYABLE_ERROR':'UNKNOWN','RESOURCE_CHANGED_BEFORE_RETENTION');}
  const state=result.status==='UNKNOWN'?'UNKNOWN':['RETRYABLE_ERROR','NEEDS_AUTH'].includes(result.status)&&c.risk==='READ'&&c.retryableRead?'PREPARED':result.status==='OK'||c.risk==='READ'&&result.status==='EMPTY'?(c.risk==='READ'||result.verification?.state==='VERIFIED'?'VERIFIED':'APPLIED_UNVERIFIED'):'FAILED';
  // Persist the outcome even after lease/auth loss; do not start another external action.
  const erased=await this.store.db.scope(ctx,async db=>{
   // Late outcomes still need durable accounting after ordinary lease loss.
   // A known content erasure vetoes bodies even if a restorer revived the action.
   await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended(current_setting('app.tenant_id',true)::uuid::text||':memory:'||current_setting('app.actor_id',true)::uuid::text,0))");
   if((await db.query('SELECT public.oa_run_content_erased($1) erased',[lease.runId])).rows[0]?.erased!==false){await db.query("UPDATE tool_actions SET state='UNKNOWN',input_ref=NULL,result=NULL,updated_at=now(),version=version+1 WHERE logical_action_key=$1 AND state='EXECUTING' AND execution_attempt_id=$2",[actionKey,executionAttempt]);return true;}
   await db.query("UPDATE tool_actions SET state=$2,result=$3,updated_at=now(),version=version+1 WHERE logical_action_key=$1 AND state='EXECUTING' AND execution_attempt_id=$4",[actionKey,state,JSON.stringify(c.protectResult?this.store.sealToolResult(ctx,actionKey,result):result),executionAttempt]);if(state==='VERIFIED'&&result.status==='OK')await this.store.consumeSourceSelection(db,lease,actionKey);return false;
  });
  return erased?blocked('UNKNOWN','PRIVATE_CONTEXT_ERASED_AFTER_DISPATCH'):result;
 }
}
import {trialState} from '../../storage/src/trial.js';
