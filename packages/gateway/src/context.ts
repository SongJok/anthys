import {isGroupCompanyAgent} from '../../company/src/agent-group-capability.js';
import {isCertifiedGroupRead,certifiedGroupReadSurface,certifiedGroupReadCheckpoint} from './group-read-surface.js';
import {isGroupCaseRead} from '../../groups/src/read-capability.js';
import {hash} from '../../storage/src/crypto.js';
import {parseCapabilityResult} from '../../contracts/src/result-contract.js';
import type pg from 'pg';
import type {Capability} from './index.js';
import type {DbContext} from '../../storage/src/database.js';
import type {RuntimeStore,Lease} from '../../runtime/src/store.js';
import type {ProviderMessage} from '../../provider-glm/src/sse.js';
import {checkpointMessages} from '../../runtime/src/checkpoint.js';
import {canonical,actionArgumentsHash,capabilityDescriptorHash} from './index.js';
import {checkpointFactAllowed} from './checkpoint.js';
import {toolResultSchema} from '../../contracts/src/index.js';
import {finalEvidenceAllowed} from './finalizer.js';
export async function contextAllowed(store:RuntimeStore,registry:ReadonlyMap<string,Capability>,ctx:DbContext,lease:Lease,history:ProviderMessage[]):Promise<boolean>{
 return store.guarded(ctx,lease,db=>contextAllowedForLease(store,registry,ctx,lease,history,db));
}
export async function contextAllowedForLease(store:RuntimeStore,registry:ReadonlyMap<string,Capability>,ctx:DbContext,lease:Lease,history:ProviderMessage[],db:pg.PoolClient):Promise<boolean>{
 if(!await store.personaContextAllowed(db,ctx,lease,history))return false;
 if(lease.audience['kind']==='GROUP'&&!certifiedGroupReadSurface(registry,history,(await db.query('SELECT * FROM tool_actions WHERE run_id=$1',[lease.runId])).rows))return false;
 const checkpoint=await store.currentCheckpoint(db,ctx,lease);if(lease.audience['kind']==='GROUP'&&checkpoint&&!certifiedGroupReadCheckpoint(registry,checkpoint,(await db.query('SELECT * FROM tool_actions WHERE run_id=$1',[lease.runId])).rows))return false;const personaMessage=checkpoint?await store.personaMessage(db,ctx,lease):null;if(checkpoint&&canonical(history.slice(0,2))!==canonical(checkpointMessages(checkpoint,personaMessage?.content??undefined)))return false;if(checkpoint)for(const fact of checkpoint.facts)if(!await checkpointFactAllowed(store,registry,ctx,lease,db,fact))return false;
 try{const calls=new Map(history.flatMap(m=>m.tool_calls??[]).map(call=>[call.id,call]));for(const message of history.filter(m=>m.role==='tool')){const result=toolResultSchema.parse(JSON.parse(message.content!)),call=calls.get(message.tool_call_id!),cap=call?registry.get(call.function.name):undefined;if(cap)parseCapabilityResult(cap,result);else if(result.data!==undefined||['OK','PARTIAL','EMPTY'].includes(result.status))return false;if(result.data===undefined){if(lease.audience['kind']==='GROUP'&&(!call||!await contextAllowedInTransaction(registry,ctx,lease,[{role:'assistant',content:null,tool_calls:[call]},message],db,undefined,true)))return false;continue;}if(!['OK','PARTIAL','EMPTY'].includes(result.status)||result.verification?.state==='MISMATCH'||!call||!cap)return false;const args=cap.schema.parse(JSON.parse(call.function.arguments)),resource=cap.resource(args,lease),argsHash=actionArgumentsHash(ctx,lease,cap,resource,args),row=(await db.query('SELECT * FROM tool_actions WHERE run_id=$1 AND capability_id=$2 AND tool_version=$3 AND args_hash=$4',[lease.runId,cap.id,cap.version,argsHash])).rows[0];if(!row?.input_ref||!['VERIFIED','FAILED','APPLIED_UNVERIFIED'].includes(row.state as string))return false;const fact={actionId:row.id as string,argsHash,name:call.function.name,capabilityId:cap.id,version:cap.version,bindingHash:cap.bindingHash,risk:cap.risk,resourceId:resource,args:store.openActionInput(ctx,row.logical_action_key as string,row.input_ref),result,authEpoch:Number(row.execution_auth_epoch),policyVersion:row.execution_policy_version as string,audience:row.execution_audience as Record<string,unknown>};if(!await finalEvidenceAllowed(store,registry,ctx,lease,db,{fact,state:row.state as string}))return false;}return true;}catch{return false;}
}
export async function contextAllowedInTransaction(registry:ReadonlyMap<string,Capability>,ctx:DbContext,lease:Lease,history:ProviderMessage[],db:pg.PoolClient,signal?:AbortSignal,requireEmptyAuthority=false):Promise<boolean>{
 try{
  if(lease.audience['kind']==='GROUP'&&history.some(m=>m.tool_calls?.some(call=>isCertifiedGroupRead(registry.get(call.function.name))))&&!certifiedGroupReadSurface(registry,history,(await db.query('SELECT * FROM tool_actions WHERE run_id=$1',[lease.runId])).rows))return false;const calls=new Map(history.flatMap(m=>m.tool_calls??[]).map(call=>[call.id,call]));
  for(const message of history.filter(m=>m.role==='tool')){
   const parsed=toolResultSchema.safeParse(JSON.parse(message.content!));if(!parsed.success)return false;const cached=parsed.data,call=calls.get(message.tool_call_id!),capability=call?registry.get(call.function.name):undefined;
   if(capability)parseCapabilityResult(capability,cached);else if(cached.data!==undefined||['OK','PARTIAL','EMPTY'].includes(cached.status))return false;
   if(cached.data===undefined&&!requireEmptyAuthority)continue;if(!call||!capability||capability.state!=='READY'||capability.risk==='FORBIDDEN')return false;
   const parameters=capability.schema.safeParse(JSON.parse(call.function.arguments));if(!parameters.success)return false;const args=parameters.data,resource=capability.resource(args,lease);
   if(capability.provider!=='CORE'){
    const binding=await db.query("SELECT id FROM capability_bindings WHERE logical_id=$1 AND semantic_version=$2 AND schema_hash=$3 AND risk=$4 AND state='READY'",[capability.id,capability.version,capability.bindingHash,capability.risk]);
    const grants=await db.query("SELECT id FROM resource_grants WHERE capability_id=$1 AND resource_id=$2 AND actor_id=$3::uuid AND audience_kind='PRIVATE_USER' AND audience_id=$3::uuid::text AND revoked_at IS NULL AND expires_at>now() AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,$4,$5,$6,$7))",[capability.id,resource,ctx.actorId,capability.version,capability.bindingHash,hash(canonical(capability.jsonSchema)),capabilityDescriptorHash(capability)]);if(!binding.rowCount||!grants.rowCount)return false;
    if(lease.audience['kind']!=='PRIVATE_USER'||lease.audience['targetId']!==ctx.actorId){const membershipVersion=isGroupCompanyAgent(capability)?(await db.query('SELECT scope_version FROM run_group_audiences WHERE id=$1 AND run_id=$2 AND proof_hash=$3',[lease.groupAudience?.id,lease.runId,lease.groupAudience?.hash])).rows[0]?.scope_version:lease.audience['membershipVersion']??null;const shared=await db.query("SELECT id FROM resource_grants WHERE capability_id=$1 AND resource_id=$2 AND actor_id=$3::uuid AND audience_kind='GROUP' AND audience_id=$4 AND membership_version=$5 AND revoked_at IS NULL AND expires_at>now() AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,$6,$7,$8,$9))",[capability.id,resource,ctx.actorId,lease.audience['targetId'],membershipVersion,capability.version,capability.bindingHash,hash(canonical(capability.jsonSchema)),capabilityDescriptorHash(capability)]);if(!shared.rowCount)return false;}
   }else if(resource!==lease.taskId||!(lease.audience['kind']==='PRIVATE_USER'&&lease.audience['targetId']===ctx.actorId||lease.audience['kind']==='GROUP'&&isGroupCaseRead(capability))){return false;
   }
   if(capability.allowResource&&!await capability.allowResource(args,{principal:ctx,lease,...(signal?{signal}:{})},db,cached))return false;
  }return true;
 }catch{return false;}
}
