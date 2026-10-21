import {z} from 'zod';
import type pg from 'pg';
import type {Gateway,Capability} from '../../gateway/src/index.js';
import {canonical,toolName} from '../../gateway/src/index.js';
import type {ProviderMessage} from '../../provider-glm/src/sse.js';
import {hash} from '../../storage/src/crypto.js';
import {dataResultContract} from '../../contracts/src/result-contract.js';
import type {ToolResult} from '../../contracts/src/index.js';
import {caseListInput,caseResultSchema} from './case-contracts.js';
import {mentionCoverage} from './case-model.js';
import type {Checkpoint} from '../../runtime/src/checkpoint.js';

export const GROUP_CASE_READ_ID='group.case.list',GROUP_CASE_READ_VERSION='1.0.0';
const safeFailure=z.object({status:z.enum(['DENIED','PERMANENT_ERROR','RETRYABLE_ERROR','UNKNOWN']),evidenceIds:z.tuple([]),completeness:z.literal('UNKNOWN'),remediation:z.object({kind:z.enum(['IDENTITY_INVALID','CANCELLED','EXPIRED','KILL_SWITCH','FORBIDDEN','SOURCE_UNAVAILABLE','PLATFORM_PERMISSION','USER_CONSENT_REQUIRED','RESOURCE_DENIED','AUDIENCE_DENIED','BUDGET_EXHAUSTED','INVALID_ARGUMENTS','ACTION_HASH_MISMATCH','WRITE_CONTRACT_CHANGED_TO_READ','CACHED_OUTPUT_CONTRACT_INVALID','RESOURCE_SOURCE_OR_EGRESS_DENIED','RECONCILIATION_REQUIRED','ACTION_ALREADY_CLAIMED','PROVIDER_FAILED','CAPABILITY_OUTPUT_INVALID','RESOURCE_CHANGED_BEFORE_RETENTION','PRIVATE_CONTEXT_ERASED_AFTER_DISPATCH','CAPABILITY_CHANGED_BEFORE_CLAIM'])}).strict()}).strict();
export const groupCaseSnapshotSchema=z.object({kind:z.literal('GROUP_CASE_RESULT_V1'),origin:z.object({group:z.string(),eventId:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),leaseHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),query:caseListInput,projection:z.object({items:z.array(caseResultSchema),nextCursor:z.uuid().nullable(),coverage:z.object({mode:z.literal('MENTION_ONLY'),completeChat:z.literal(false),notice:z.literal(mentionCoverage.notice),from:z.iso.datetime({offset:true}),until:z.iso.datetime({offset:true}),selection:z.literal('CASE_REGISTRATION_TIME')}).strict(),contractVersion:z.number().int().positive().safe()}).strict()}).strict();
export const groupCaseReadResultContract=dataResultContract(groupCaseSnapshotSchema);
export const groupCaseReadBindingHash=hash(canonical({id:GROUP_CASE_READ_ID,version:GROUP_CASE_READ_VERSION,input:z.toJSONSchema(caseListInput),output:groupCaseReadResultContract.outputSchema,retrySafety:'CERTIFIED_LOCAL_READ',meaning:'Actual current group registered cases only; no enterprise resource authority'}));
const certified=new WeakSet<Capability>();
/** Object identity is private to the reviewed factory, never inferred from an ID/CORE flag. */
export function isGroupCaseRead(c:Capability|undefined):boolean{return !!c&&certified.has(c);}
export function groupCaseReadRow(registry:ReadonlyMap<string,Capability>,row:pg.QueryResultRow):boolean{
 const cap=registry.get(toolName(row.capability_id as string,row.tool_version as string));return isGroupCaseRead(cap)&&row.binding_hash===groupCaseReadBindingHash&&row.risk==='READ'&&row.provider_id==='CORE'&&row.connector_id==='CORE';
}
/** Validate every surface, including calls which returned no data or never executed. */
export function groupCaseReadSurface(registry:ReadonlyMap<string,Capability>,history:ProviderMessage[],rows:pg.QueryResultRow[]):boolean{
 const calls=new Set<string>(),closed=new Set<string>();
 try{for(const message of history)for(const call of message.tool_calls??[]){const cap=registry.get(call.function.name);if(message.role!=='assistant'||call.type!=='function'||calls.has(call.id)||!isGroupCaseRead(cap)||!cap!.schema.safeParse(JSON.parse(call.function.arguments)).success)return false;calls.add(call.id);}
 for(const message of history)if(message.role==='tool'){if(!message.tool_call_id||!calls.has(message.tool_call_id)||closed.has(message.tool_call_id))return false;const result=JSON.parse(message.content!);if(result.data===undefined&&!safeFailure.safeParse(result).success)return false;closed.add(message.tool_call_id);}}catch{return false;}
 return rows.every(row=>groupCaseReadRow(registry,row));
}
export function groupCaseReadCheckpoint(registry:ReadonlyMap<string,Capability>,checkpoint:Checkpoint,rows:pg.QueryResultRow[]):boolean{
 return checkpoint.facts.every(f=>isGroupCaseRead(registry.get(f.name))&&rows.some(r=>r.id===f.actionId&&groupCaseReadRow(registry,r)))&&checkpoint.actions.every(a=>a.capabilityId===GROUP_CASE_READ_ID&&a.risk==='READ'&&rows.some(r=>r.id===a.id&&r.args_hash===a.argsHash&&r.state===a.state&&groupCaseReadRow(registry,r)))&&checkpoint.omitted.every(o=>['RESULT_NOT_VERIFIED','LEGACY_OR_MISSING_PROVENANCE','CURRENT_AUTHORIZATION_OR_SOURCE_CHANGED','INVALID_OR_UNAVAILABLE_PROVENANCE','CONTEXT_BUDGET'].includes(o.reason)&&rows.some(r=>r.id===o.actionId&&groupCaseReadRow(registry,r)))&&checkpoint.unexecutedCalls.every(call=>isGroupCaseRead(registry.get(call.name)));
}
export function groupCaseReadResult(raw:unknown):ToolResult{
 const data=groupCaseSnapshotSchema.parse(raw),p=data.projection;
 return {status:'OK',data,evidenceIds:['group-case-snapshot:'+hash(canonical(data))],completeness:p.nextCursor?'TRUNCATED':'COMPLETE',...(p.nextCursor?{nextCursor:p.nextCursor}:{}),coverage:{from:p.coverage.from,to:p.coverage.until,source:'CURRENT_GROUP_REGISTERED_CASES',gaps:['NOT_ALL_GROUP_CHAT',...(p.nextCursor?['MORE_PAGES']:[])]},verification:{state:'VERIFIED',method:'CURRENT_LOCAL_CASE_SNAPSHOT_NOT_COMPLETION_VERIFICATION'}};
}
export function registerGroupCaseRead(gateway:Gateway){
 const store=gateway.store;if(!store.groupCases||!store.groupAudiences)throw Error('GROUP_CASE_READ_CONFIGURATION_REQUIRED');
 const service=store.groupCases,audiences=store.groupAudiences;
 const cap:Capability={...groupCaseReadResultContract,id:GROUP_CASE_READ_ID,version:GROUP_CASE_READ_VERSION,description:'Read only this group’s registered mention/card cases within an explicit UTC registration interval (max 31 days), cursor and limit. Not all group chat. Preserve each case/resource/source and completion.method. Owner reports and administrator confirmation are not external automatic verification. No write or arbitrary enterprise resource access.',provider:'CORE',risk:'READ',authModes:['CORE'],requiredPermissions:[{name:'Current reviewed group contract case.read and current audience',evidenceRef:'core:group-cases.read'}],supportsDryRun:false,supportsIdempotency:true,bindingRef:'core:group-cases.read',state:'READY',schema:caseListInput,jsonSchema:z.toJSONSchema(caseListInput),bindingHash:groupCaseReadBindingHash,resource:(_args,lease)=>lease.taskId,protectResult:true,retryableRead:true,classifyResult:()=> 'INTERNAL',allowResource:async(args,{principal,lease,signal},db,cached)=>{
  try{if(cached===undefined||cached===null){await service.modelReadAllowed(db,principal,lease,audiences,signal);return true;}const value=cached as ToolResult;if(value.data===undefined){await service.modelReadAllowed(db,principal,lease,audiences,signal);return !['OK','PARTIAL','EMPTY'].includes(value.status);}const current=groupCaseReadResult(await service.modelRead(db,principal,lease,audiences,args,signal));return canonical(current)===canonical(value);}catch{signal?.throwIfAborted();return false;}
 },execute:async(args,{principal,lease,signal})=>store.guarded(principal,lease,async db=>groupCaseReadResult(await service.modelRead(db,principal,lease,audiences,args,signal)))};
 // Freeze callback/descriptor identities before allowing this one group exception.
 Object.freeze(cap);certified.add(cap);gateway.register(cap);
}
