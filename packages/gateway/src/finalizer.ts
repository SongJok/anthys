import {certifiedGroupReadSurface,certifiedGroupReadCheckpoint} from './group-read-surface.js';
import {isGroupCaseRead,groupCaseSnapshotSchema} from '../../groups/src/read-capability.js';
import {logResultCitation} from '../../company/src/log-citation.js';
import {parseCapabilityResult} from '../../contracts/src/result-contract.js';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import type {RuntimeStore,Lease} from '../../runtime/src/store.js';
import type {CheckpointFact} from '../../runtime/src/checkpoint.js';
import {toolResultSchema,type ToolResult} from '../../contracts/src/index.js';
import {parseFinalPlan,assertNoUnbackedActionProse,readFinalPointer,safeSocialReply,FinalAnswerError,type FinalRef} from '../../runtime/src/final-plan.js';
import {canonical,toolName,actionArgumentsHash,type Capability} from './index.js';
import {contextAllowedInTransaction} from './context.js';
import {killed} from './controls.js';
import {requireNarrativeReceipt,renderClarification} from '../../runtime/src/narrative-review.js';
import {randomUUID} from 'node:crypto';
import {hash} from '../../storage/src/crypto.js';
import {choiceProjectionSchema,choiceText,type SourceChoice} from '../../runtime/src/source-choice.js';

export type FinalEvidence={fact:CheckpointFact;state:string;choiceProjection?:{version:string;hash:string}|undefined};
export type FinalizedAnswer={text:string;partial:boolean;reason:string|null;evidence:FinalEvidence[];classification:string;narrativeReviewId?:string;waitingUser?:boolean;sourceChoice?:{id:string;proof:SourceChoice}};
type Resolved={result:ToolResult;action:Record<string,unknown>|null;fact:CheckpointFact|null};
export async function finalEvidenceAllowed(store:RuntimeStore,registry:ReadonlyMap<string,Capability>,ctx:DbContext,lease:Lease,c:pg.PoolClient,evidence:FinalEvidence,signal?:AbortSignal):Promise<boolean>{
 try{
  const f=evidence.fact,cap=registry.get(f.name);if(!cap||cap.state!=='READY'||cap.risk==='FORBIDDEN'||cap.id!==f.capabilityId||cap.version!==f.version||cap.bindingHash!==f.bindingHash||cap.risk!==f.risk||f.authEpoch!==lease.authEpoch||f.policyVersion!==lease.policyVersion||canonical(f.audience)!==canonical(lease.audience)||await killed(c,ctx,lease,cap.connectorId??cap.provider,false))return false;
  const args=cap.schema.safeParse(f.args);if(!args.success||canonical(args.data)!==canonical(f.args)||cap.resource(args.data,lease)!==f.resourceId||actionArgumentsHash(ctx,lease,cap,f.resourceId,args.data)!==f.argsHash)return false;
  const row=(await c.query('SELECT * FROM tool_actions WHERE id=$1 AND run_id=$2',[f.actionId,lease.runId])).rows[0];if(!row||row.state!==evidence.state||row.args_hash!==f.argsHash||row.capability_id!==f.capabilityId||row.tool_version!==f.version||row.binding_hash!==f.bindingHash||row.risk!==f.risk||row.resource_id!==f.resourceId||Number(row.execution_auth_epoch)!==f.authEpoch||row.execution_policy_version!==f.policyVersion||canonical(row.execution_audience)!==canonical(f.audience))return false;
  if(row.provider_id!==cap.provider||row.connector_id!==(cap.connectorId??cap.provider))return false;
  const current=parseCapabilityResult(cap,cap.protectResult?store.openToolResult(ctx,row.logical_action_key as string,row.result):row.result);if(canonical(current)!==canonical(f.result))return false;
  if(evidence.choiceProjection){if(!cap.sourceChoices||cap.sourceChoices.version!==evidence.choiceProjection.version)return false;const p=choiceProjectionSchema.parse(cap.sourceChoices.project(current)),target=registry.get(toolName(p.next.id,p.next.version));if(hash(canonical(p))!==evidence.choiceProjection.hash||!target||target.risk!=='READ'||target.state!=='READY'||target.bindingHash!==p.next.bindingHash)return false;}
  // Empty/error results still require current capability/resource authority.
  const authorizationResult=current;
  if(!await contextAllowedInTransaction(registry,ctx,lease,[{role:'assistant',content:null,tool_calls:[{id:f.actionId,type:'function',function:{name:f.name,arguments:JSON.stringify(f.args)}}]},{role:'tool',tool_call_id:f.actionId,content:JSON.stringify(authorizationResult)}],c,signal,true))return false;
  if(cap.provider!=='CORE'&&cap.risk==='READ'&&current.data!==undefined&&!cap.allowResource)return false;
  return true;
 }catch{return false;}
}
export async function verifyFinalAnswer(store:RuntimeStore,registry:ReadonlyMap<string,Capability>,ctx:DbContext,lease:Lease,c:pg.PoolClient,content:string):Promise<FinalizedAnswer>{
 const plan=parseFinalPlan(content);assertNoUnbackedActionProse(plan.text);
 if(!await store.personaAllowed(c,ctx,lease))throw new FinalAnswerError('PERSONA_CONTEXT_UNAVAILABLE');const personaClassification=await store.personaClassification(c,ctx,lease);
 if(!await store.groupAudienceAllowed(c,ctx,lease))throw new FinalAnswerError('GROUP_AUDIENCE_CHANGED');
 if(plan.mode!=='SOURCE_CHOICE'&&plan.sourceChoice)throw new FinalAnswerError('FINAL_MODE_MISMATCH');
 // Free narrative is not silently rewritten or treated as verified merely
 // because adjacent structured claims are valid. Preserve/reject the draft.
 if(plan.mode==='REPORT'&&plan.text.length)throw new FinalAnswerError('FINAL_NARRATIVE_UNVERIFIED');
 if(plan.mode==='CONVERSATION'&&(plan.claims.length||plan.outcome!=='COMPLETE'))throw new FinalAnswerError('FINAL_MODE_MISMATCH');
 if(plan.mode==='CLARIFICATION'&&(plan.claims.length||plan.outcome!=='CLARIFICATION'))throw new FinalAnswerError('FINAL_MODE_MISMATCH');
 const history=await store.historyInTransaction(c,ctx,lease),checkpoint=await store.currentCheckpoint(c,ctx,lease),rows=(await c.query('SELECT * FROM tool_actions WHERE run_id=$1 ORDER BY created_at,id',[lease.runId])).rows;
 if(!await store.personaContextAllowed(c,ctx,lease,history))throw new FinalAnswerError('PERSONA_CONTEXT_CHANGED');
 const calls=new Map(history.flatMap(m=>m.tool_calls??[]).map(call=>[call.id,call])),results=new Map(history.filter(m=>m.role==='tool').map(m=>[m.tool_call_id!,toolResultSchema.parse(JSON.parse(m.content!))]));
 if(lease.audience['kind']==='GROUP'&&(!certifiedGroupReadSurface(registry,history,rows)||checkpoint&&!certifiedGroupReadCheckpoint(registry,checkpoint,rows)))throw new FinalAnswerError('GROUP_RESOURCE_SHARING_UNCERTIFIED');
 const facts=checkpoint?.facts??[],evidence:FinalEvidence[]=[],cache=new Map<string,Resolved>();
 async function resolve(ref:FinalRef):Promise<Resolved>{
  const key=ref.kind+':'+ref.id,existing=cache.get(key);if(existing)return existing;
  let row:Record<string,unknown>|undefined,journalResult:ToolResult|undefined;
  if(ref.kind==='TOOL_CALL'){
   const call=calls.get(ref.id);journalResult=results.get(ref.id);if(!call||!journalResult)throw new FinalAnswerError('FINAL_REFERENCE_MISSING');
   const cap=registry.get(call.function.name),args=cap?.schema.safeParse(JSON.parse(call.function.arguments));
   if(cap&&args?.success){const argsHash=actionArgumentsHash(ctx,lease,cap,cap.resource(args.data,lease),args.data);row=rows.find(r=>r.args_hash===argsHash&&r.capability_id===cap.id&&r.tool_version===cap.version);}
   if(!row){if(journalResult.data!==undefined||!['DENIED','NEEDS_AUTH','NEEDS_APPROVAL','PERMANENT_ERROR'].includes(journalResult.status))throw new FinalAnswerError('FINAL_ACTION_PROVENANCE_MISSING');const resolved={result:journalResult,action:null,fact:null};cache.set(key,resolved);return resolved;}
  }else{
   if(!facts.some(f=>f.actionId===ref.id)&&!checkpoint?.actions.some(a=>a.id===ref.id))throw new FinalAnswerError('FINAL_REFERENCE_MISSING');row=rows.find(r=>r.id===ref.id);
  }
  if(!row?.input_ref||!row.result)throw new FinalAnswerError('FINAL_ACTION_PROVENANCE_MISSING');
  const cap=registry.get(toolName(row.capability_id as string,row.tool_version as string));if(!cap)throw new FinalAnswerError('FINAL_SOURCE_CHANGED');
  let result:ToolResult,args:unknown;try{result=parseCapabilityResult(cap,cap.protectResult?store.openToolResult(ctx,row.logical_action_key as string,row.result):row.result);args=store.openActionInput(ctx,row.logical_action_key as string,row.input_ref);}catch{throw new FinalAnswerError('FINAL_SOURCE_UNREADABLE');}
  if(result.verification?.state==='MISMATCH'||cap.risk==='READ'&&result.status==='OK'&&row.state!=='VERIFIED')throw new FinalAnswerError('FINAL_SOURCE_VERIFICATION_FAILED');
  if(journalResult&&canonical(journalResult)!==canonical(result))throw new FinalAnswerError('FINAL_RESULT_MISMATCH');
  const fact:CheckpointFact={actionId:row.id as string,argsHash:row.args_hash as string,name:toolName(cap.id,cap.version),capabilityId:cap.id,version:cap.version,bindingHash:cap.bindingHash,risk:cap.risk,resourceId:row.resource_id as string,args,result,authEpoch:Number(row.execution_auth_epoch),policyVersion:row.execution_policy_version as string,audience:row.execution_audience as Record<string,unknown>};
  const proof={fact,state:row.state as string};if(!await finalEvidenceAllowed(store,registry,ctx,lease,c,proof))throw new FinalAnswerError('FINAL_SOURCE_CHANGED');
  evidence.push(proof);const resolved={result,action:row,fact};cache.set(key,resolved);return resolved;
 }
 if(!await store.sourceSelectionsAllowed(c,ctx,lease,async(principal,snapshot,client,items)=>{for(const e of items)if(!await finalEvidenceAllowed(store,registry,principal,snapshot,client,e))return false;return true;}))throw new FinalAnswerError('SOURCE_CHOICE_SOURCE_CHANGED');
 const pendingSelection=await store.pendingSourceSelection(c,ctx,lease);if(pendingSelection&&(plan.outcome==='COMPLETE'||plan.mode==='SOURCE_CHOICE'))throw new FinalAnswerError('SOURCE_SELECTION_NOT_EXECUTED');
 if(plan.mode==='SOURCE_CHOICE'){
  if(plan.text||plan.claims.length||plan.outcome!=='CLARIFICATION'||!plan.sourceChoice||lease.audience['kind']!=='PRIVATE_USER'||lease.audience['targetId']!==ctx.actorId)throw new FinalAnswerError('SOURCE_CHOICE_PLAN_INVALID');
  const r=await resolve(plan.sourceChoice.ref),cap=r.fact?registry.get(r.fact.name):undefined;if(!r.fact||!cap?.sourceChoices||cap.risk!=='READ'||r.action?.state!=='VERIFIED'||!['OK','PARTIAL'].includes(r.result.status)||r.result.verification?.state!=='VERIFIED')throw new FinalAnswerError('SOURCE_CHOICE_SOURCE_UNAVAILABLE');
  let projection;try{projection=choiceProjectionSchema.parse(cap.sourceChoices.project(r.result));}catch{throw new FinalAnswerError('SOURCE_CHOICE_PROJECTION_INVALID');}const target=registry.get(toolName(projection.next.id,projection.next.version));if(!target||target.state!=='READY'||target.risk!=='READ'||target.bindingHash!==projection.next.bindingHash||projection.options.some(o=>{const a=target.schema.safeParse(o.args);return !a.success||canonical(a.data)!==canonical(o.args);}))throw new FinalAnswerError('SOURCE_CHOICE_TARGET_UNAVAILABLE');
  const projectionHash=hash(canonical(projection));evidence[0]!.choiceProjection={version:cap.sourceChoices.version,hash:projectionHash};if(!await finalEvidenceAllowed(store,registry,ctx,lease,c,evidence[0]!))throw new FinalAnswerError('FINAL_SOURCE_CHANGED');
  const id=randomUUID(),sessionNo=Number((await c.query('SELECT provider_session_no FROM runs WHERE id=$1',[lease.runId])).rows[0].provider_session_no),proof:SourceChoice={version:1,lease:lease as SourceChoice['lease'],sessionNo,projection,evidence,proposalHash:hash(content),projectionHash};return {text:choiceText(projection,id,!!(await c.query('SELECT source_event_id FROM tasks WHERE id=$1',[lease.taskId])).rows[0]?.source_event_id),partial:true,reason:'SOURCE_CHOICE_REQUIRED',evidence,classification:['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'][Math.max(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'].indexOf(personaClassification),['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'].indexOf(cap.classifyResult?.(r.result)??'RESTRICTED'))]!,waitingUser:true,sourceChoice:{id,proof}};
 }
 const usable=history.some(m=>m.role==='tool'&&(()=>{const r=results.get(m.tool_call_id!);return r?.data!==undefined&&['OK','PARTIAL','EMPTY'].includes(r.status);})())||facts.length>0,write=rows.some(r=>r.risk!=='READ');
 let narrativeReviewId:string|undefined;
 if(plan.mode==='CLARIFICATION'||plan.mode==='CONVERSATION'&&!safeSocialReply(lease.goal,plan.text)){
  const input=await store.narrativeInputInTransaction(c,ctx,lease,content,history);if(!input||usable||write)throw new FinalAnswerError(plan.mode==='CLARIFICATION'?'FINAL_NARRATIVE_UNVERIFIED':'FINAL_BUSINESS_PLAN_REQUIRED');
  narrativeReviewId=requireNarrativeReceipt(await store.narrativeReceipt(c,ctx,lease,content,input));
 }
 if(plan.mode==='CONVERSATION'&&(usable||write))throw new FinalAnswerError('FINAL_BUSINESS_PLAN_REQUIRED');
 if(plan.mode==='REPORT'&&!plan.claims.length)throw new FinalAnswerError('FINAL_CLAIMS_REQUIRED');
 let partial=plan.outcome!=='COMPLETE';const lines:string[]=[],dataSources=new Set<string>();
 if(plan.mode!=='REPORT')lines.push(plan.text);
 for(const claim of plan.claims){
  if(claim.kind==='LIMITATION'){const omitted=checkpoint?.omitted.find(o=>o.actionId===claim.ref.id&&o.reason===claim.expectedReason);if(!omitted)throw new FinalAnswerError('FINAL_LIMITATION_MISMATCH');lines.push(`资料未用于结论：${omitted.reason}。［动作 ${omitted.actionId}］`);partial=true;continue;}
  const resolved=await resolve(claim.ref),r=resolved.result,provenance=(resolved.fact?`${resolved.fact.capabilityId}@${resolved.fact.version} · ${resolved.fact.actionId}`:`未执行调用 ${claim.ref.id}`)+(resolved.fact?.capabilityId==='company.logs.query'?' · '+logResultCitation(r):'');
  if(claim.kind==='STATUS'){
   if(r.status!==claim.expected)throw new FinalAnswerError('FINAL_STATUS_MISMATCH');
   lines.push(`工具结果：${r.status}；范围：${r.completeness}${r.verification?`；上游核验：${r.verification.state}`:''}。［${provenance}］`);if(!['OK','EMPTY'].includes(r.status)||r.completeness!=='COMPLETE'||r.verification?.state==='UNVERIFIED')partial=true;
  }else if(claim.kind==='ACTION'){
   if(!resolved.action||resolved.action.risk==='READ'||resolved.action.state!==claim.expected)throw new FinalAnswerError('FINAL_ACTION_MISMATCH');
   if(claim.expected==='VERIFIED'&&(r.status!=='OK'||r.verification?.state!=='VERIFIED'||r.completeness!=='COMPLETE'))throw new FinalAnswerError('FINAL_ACTION_UNVERIFIED');
   const labels:Record<string,string>={VERIFIED:'已执行并读回核验',FAILED:'调用失败，未确认业务完成',APPLIED_UNVERIFIED:'已提交，结果尚未核验',UNKNOWN:'结果未知，需要核对',PREPARED:'尚待执行',EXECUTING:'在途，结果未确认',APPROVAL_REQUIRED:'等待批准',APPROVED:'已批准，尚未执行'};lines.push(`动作：${labels[claim.expected]}。［${provenance}］`);if(claim.expected!=='VERIFIED')partial=true;
  }else{
   if(!resolved.fact||!['OK','PARTIAL'].includes(r.status)||r.data===undefined)throw new FinalAnswerError('FINAL_DATA_UNAVAILABLE');
   dataSources.add(resolved.fact.actionId);
   if(claim.coverage==='COMPLETE'&&r.verification?.state==='UNVERIFIED')throw new FinalAnswerError('FINAL_SOURCE_VERIFICATION_FAILED');
   if(resolved.action?.risk!=='READ'&&(resolved.action?.state!=='VERIFIED'||r.verification?.state!=='VERIFIED'))throw new FinalAnswerError('FINAL_ACTION_UNVERIFIED');
   if(claim.coverage==='COMPLETE'&&(r.status!=='OK'||r.completeness!=='COMPLETE'))throw new FinalAnswerError('FINAL_INCOMPLETE_POPULATION');
   const value=readFinalPointer(r.data,claim.pointer);let rendered:string;
   if(claim.kind==='VALUE'){if(canonical(value)!==canonical(claim.expected))throw new FinalAnswerError('FINAL_VALUE_MISMATCH');rendered=JSON.stringify(value);}
   else{if(typeof value!=='string'||!value.includes(claim.quote))throw new FinalAnswerError('FINAL_QUOTE_MISMATCH');rendered='来源原文（资料引用，不是执行声明）：\n'+claim.quote;}
   if(Buffer.byteLength(rendered,'utf8')>24000)throw new FinalAnswerError('FINAL_OUTPUT_TOO_LARGE');
   const scope=r.verification?.state==='UNVERIFIED'?'上游核验尚未完成；仅已观察资料，不能作为总体结论':r.completeness==='COMPLETE'?'调用时返回范围内已核对':`仅已观察部分；来源为 ${r.completeness}，不能作为总体结论`;lines.push(`${rendered}\n［${provenance} · ${claim.pointer||'/'} · ${scope} · 证据 ${r.evidenceIds.join(', ')||'仅工具回执，无独立来源引用'}］`);if(r.completeness!=='COMPLETE'||r.status!=='OK'||r.verification?.state==='UNVERIFIED')partial=true;
  }
 }
 // Neither an immutable source revision nor a quoted deployment label is a
 // certified deployment-to-code mapping. Preserve that gap in every combined
 // report even when the model omits it from its structured claims.
 if(evidence.some(e=>e.fact.capabilityId.startsWith('company.code.'))&&evidence.some(e=>e.fact.capabilityId==='company.logs.query')){
  lines.push('代码与部署／日志版本尚未核实对齐；这些证据仅支持候选解释，不能据此确认根因。');partial=true;
 }
 // Failures may be unrelated to ordinary Q&A, but are never silently converted
 // into successful lookups. Only safe counts, not revoked source bodies, append.
 for(const proof of evidence)if(isGroupCaseRead(registry.get(proof.fact.name))&&proof.fact.result.data!==undefined){const snapshot=groupCaseSnapshotSchema.parse(proof.fact.result.data),p=snapshot.projection;lines.push(`${p.coverage.notice} 登记时间范围：[${p.coverage.from}, ${p.coverage.until})；当前页 ${p.items.length} 条；${p.nextCursor?'仍有下一页，不能作为完整范围汇总':'当前查询页已读完'}。UNVERIFIED/OWNER_REPORTED 是负责人声明；ADMIN_CONFIRMED 仅是独立管理员人工确认，均不是外部工具自动核验。`);partial=true;}
 const failed=rows.filter(r=>r.state==='FAILED').length;if(failed)lines.push(`另有 ${failed} 项工具调用未完成；这些调用未被当作成功证据。`);
 if(rows.some(r=>r.state==='PREPARED')){partial=true;lines.push('仍有工具请求尚待执行。');}
 const text=plan.mode==='CLARIFICATION'?renderClarification(lines.join('\n\n'),narrativeReviewId!,!!(await c.query('SELECT source_event_id FROM tasks WHERE id=$1',[lease.taskId])).rows[0]?.source_event_id,lease.audience['kind']==='GROUP'):lines.join('\n\n');if(!text.trim()||Buffer.byteLength(text,'utf8')>96000)throw new FinalAnswerError('FINAL_OUTPUT_INVALID');
 const classification=evidence.reduce((level,proof)=>{if(!dataSources.has(proof.fact.actionId))return level;const cap=registry.get(proof.fact.name),source=cap?.classifyResult?.(proof.fact.result)??(cap?.provider==='CORE'?'INTERNAL':'RESTRICTED'),levels=['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'];return levels[Math.max(levels.indexOf(level),levels.indexOf(source)<0?3:levels.indexOf(source))]!;},personaClassification);
 return {text,partial,reason:plan.mode==='CLARIFICATION'?'CLARIFICATION_REQUESTED':partial?'FINAL_PARTIAL_EVIDENCE':narrativeReviewId?'GENERAL_KNOWLEDGE_MODEL_REVIEW':null,evidence,classification,...(narrativeReviewId?{narrativeReviewId}:{}),...(plan.mode==='CLARIFICATION'?{waitingUser:true}:{} )};
}
