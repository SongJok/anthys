import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import type {RuntimeStore,Lease} from '../../runtime/src/store.js';
import {checkpointFactSchema} from '../../runtime/src/checkpoint.js';
import {attachmentDependenciesAllowed,inheritedAttachmentClassification} from '../../attachments/src/egress.js';
import {parseCapabilityResult} from '../../contracts/src/result-contract.js';
import {toolName,type Capability} from './index.js';
import {finalEvidenceAllowed,type FinalEvidence} from './finalizer.js';
import {contextAllowedForLease} from './context.js';

/** Capture persisted source provenance without checkpoint recovery: recovery
 * would change the currently EXECUTING artifact action to UNKNOWN. The caller
 * supplies the exact current action; all other unresolved actions reject. */
export async function snapshotToolSources(store:RuntimeStore,registry:ReadonlyMap<string,Capability>,ctx:DbContext,lease:Lease,c:pg.PoolClient,currentActionKey:string,signal:AbortSignal){
 signal.throwIfAborted();
 const history=await store.historyInTransaction(c,ctx,lease);
 if(!await contextAllowedForLease(store,registry,ctx,lease,history,c)||!await store.personaContextAllowed(c,ctx,lease,history,signal)||!await store.sourceSelectionsAllowed(c,ctx,lease,async(p,l,db,items)=>{for(const item of items)if(!await finalEvidenceAllowed(store,registry,p,l,db,item,signal))return false;return true;},signal))throw Error('SOURCE_CONTEXT_CHANGED');
 const session=Number((await c.query('SELECT provider_session_no FROM runs WHERE id=$1',[lease.runId])).rows[0]?.provider_session_no);
 if(!Number.isInteger(session)||session<1||session>32||!await attachmentDependenciesAllowed(c,ctx,lease.taskId,{runId:lease.runId,sessionNo:session}))throw Error('SOURCE_CONTEXT_CHANGED');
 const rows=(await c.query('SELECT * FROM tool_actions WHERE run_id=$1 AND logical_action_key<>$2 ORDER BY created_at,id',[lease.runId,currentActionKey])).rows;
 if(rows.length>64)throw Error('SOURCE_SNAPSHOT_LIMIT');
 const evidence:FinalEvidence[]=[];
 const levels=['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'];
 let rank=Math.max(1,levels.indexOf(await store.personaClassification(c,ctx,lease)),levels.indexOf(await inheritedAttachmentClassification(c,lease.taskId,{runId:lease.runId,sessionNo:session})));
 for(const row of rows){
  signal.throwIfAborted();
  if(!['VERIFIED','FAILED','APPLIED_UNVERIFIED'].includes(row.state as string)||!row.input_ref||!row.result)throw Error('SOURCE_ACTION_UNRESOLVED');
  const capability=registry.get(toolName(row.capability_id as string,row.tool_version as string));if(!capability)throw Error('SOURCE_CAPABILITY_CHANGED');
  const fact=checkpointFactSchema.parse({actionId:row.id,argsHash:row.args_hash,name:toolName(capability.id,capability.version),capabilityId:row.capability_id,version:row.tool_version,bindingHash:row.binding_hash,risk:row.risk,resourceId:row.resource_id,args:store.openActionInput(ctx,row.logical_action_key as string,row.input_ref),result:parseCapabilityResult(capability,capability.protectResult?store.openToolResult(ctx,row.logical_action_key as string,row.result):row.result),authEpoch:Number(row.execution_auth_epoch),policyVersion:row.execution_policy_version,audience:row.execution_audience});
  const item={fact,state:row.state as string};
  if(!await finalEvidenceAllowed(store,registry,ctx,lease,c,item,signal))throw Error('SOURCE_AUTHORITY_CHANGED');
  const classification=capability.classifyResult?.(fact.result)??(capability.provider==='CORE'?'INTERNAL':'RESTRICTED');
  rank=Math.max(rank,levels.indexOf(classification)<0?3:levels.indexOf(classification));evidence.push(item);
 }
 signal.throwIfAborted();return {evidence,sessionNo:session,classification:levels[rank]!};
}
