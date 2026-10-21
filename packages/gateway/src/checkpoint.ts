import {parseCapabilityResult} from '../../contracts/src/result-contract.js';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import type {RuntimeStore,Lease} from '../../runtime/src/store.js';
import type {CheckpointDraft,CheckpointFact} from '../../runtime/src/checkpoint.js';
import {checkpointFactSchema} from '../../runtime/src/checkpoint.js';
import type {ProviderMessage} from '../../provider-glm/src/sse.js';
import {toolName,type Capability} from './index.js';
import {finalEvidenceAllowed} from './finalizer.js';
export async function checkpointFactAllowed(store:RuntimeStore,registry:ReadonlyMap<string,Capability>,ctx:DbContext,lease:Lease,c:pg.PoolClient,fact:CheckpointFact):Promise<boolean>{
 if(fact.result.status!=='OK'||fact.result.verification&&fact.result.verification.state!=='VERIFIED'||fact.risk!=='READ'&&fact.result.verification?.state!=='VERIFIED')return false;
 return finalEvidenceAllowed(store,registry,ctx,lease,c,{fact,state:'VERIFIED'});
}
export async function draftCheckpoint(store:RuntimeStore,registry:ReadonlyMap<string,Capability>,ctx:DbContext,lease:Lease,c:pg.PoolClient,history:ProviderMessage[]):Promise<CheckpointDraft>{
 const rows=(await c.query('SELECT * FROM tool_actions WHERE run_id=$1 ORDER BY created_at,id',[lease.runId])).rows,draft:CheckpointDraft={actions:[],facts:[],omitted:[],unexecutedCalls:[],blocked:null};
 const closed=new Set(history.filter(m=>m.role==='tool').map(m=>m.tool_call_id));for(const call of history.flatMap(m=>m.tool_calls??[]))if(!closed.has(call.id))draft.unexecutedCalls.push({callId:hash(call.id),name:/^cap_[a-f0-9]{12}$/.test(call.function.name)?call.function.name:'UNREVIEWED_TOOL'});
 for(const row of rows){
  if(row.state==='EXECUTING'){row.state=row.retry_safety==='CERTIFIED_READ'?'PREPARED':'UNKNOWN';await c.query('UPDATE tool_actions SET state=$2,updated_at=now(),version=version+1 WHERE id=$1',[row.id,row.state]);}
  if(row.state==='UNKNOWN')draft.blocked='RECONCILIATION_REQUIRED';else if(!draft.blocked&&['APPROVAL_REQUIRED','APPROVED'].includes(row.state as string))draft.blocked='APPROVAL_CONTEXT_RECOVERY_REQUIRED';
  const capability=typeof row.capability_id==='string'?registry.get(toolName(row.capability_id,row.tool_version as string)):undefined;
  draft.actions.push({id:row.id as string,capabilityId:capability?.id??null,argsHash:row.args_hash as string,state:row.state as string,risk:row.risk as string|null});
  if(row.state!=='VERIFIED'){draft.omitted.push({actionId:row.id as string,reason:'RESULT_NOT_VERIFIED'});continue;}
  if(!capability||!row.input_ref){draft.omitted.push({actionId:row.id as string,reason:'LEGACY_OR_MISSING_PROVENANCE'});continue;}
  try{const fact=checkpointFactSchema.parse({actionId:row.id,argsHash:row.args_hash,name:toolName(capability.id,capability.version),capabilityId:row.capability_id,version:row.tool_version,bindingHash:row.binding_hash,risk:row.risk,resourceId:row.resource_id,args:store.openActionInput(ctx,row.logical_action_key as string,row.input_ref),result:parseCapabilityResult(capability,capability.protectResult?store.openToolResult(ctx,row.logical_action_key as string,row.result):row.result),authEpoch:Number(row.execution_auth_epoch),policyVersion:row.execution_policy_version,audience:row.execution_audience});
   if(await checkpointFactAllowed(store,registry,ctx,lease,c,fact))draft.facts.push(fact);else draft.omitted.push({actionId:row.id as string,reason:'CURRENT_AUTHORIZATION_OR_SOURCE_CHANGED'});
  }catch{draft.omitted.push({actionId:row.id as string,reason:'INVALID_OR_UNAVAILABLE_PROVENANCE'});}
 }return draft;
}
