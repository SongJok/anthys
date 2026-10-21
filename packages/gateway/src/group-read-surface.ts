import type pg from 'pg';
import {z} from 'zod';
import {groupCaseReadSurface,groupCaseReadCheckpoint,isGroupCaseRead} from '../../groups/src/read-capability.js';
import {isGroupCompanyAgent} from '../../company/src/agent-group-capability.js';
import {agentTextResultContract} from '../../company/src/agent-result.js';
import {toolName,type Capability} from './index.js';
import type {ProviderMessage} from '../../provider-glm/src/sse.js';
import type {Checkpoint} from '../../runtime/src/checkpoint.js';
export const isCertifiedGroupRead=(c:Capability|undefined)=>isGroupCaseRead(c)||isGroupCompanyAgent(c);
const failure=z.object({status:z.enum(['DENIED','PERMANENT_ERROR','RETRYABLE_ERROR','UNKNOWN']),evidenceIds:z.tuple([]),completeness:z.literal('UNKNOWN'),remediation:z.object({kind:z.enum(['IDENTITY_INVALID','CANCELLED','EXPIRED','KILL_SWITCH','FORBIDDEN','SOURCE_UNAVAILABLE','PLATFORM_PERMISSION','USER_CONSENT_REQUIRED','RESOURCE_DENIED','AUDIENCE_DENIED','BUDGET_EXHAUSTED','INVALID_ARGUMENTS','ACTION_HASH_MISMATCH','CACHED_OUTPUT_CONTRACT_INVALID','RESOURCE_SOURCE_OR_EGRESS_DENIED','RECONCILIATION_REQUIRED','ACTION_ALREADY_CLAIMED','PROVIDER_FAILED','CAPABILITY_OUTPUT_INVALID','RESOURCE_CHANGED_BEFORE_RETENTION','PRIVATE_CONTEXT_ERASED_AFTER_DISPATCH','CAPABILITY_CHANGED_BEFORE_CLAIM'])}).strict()}).strict();
function agentRow(registry:ReadonlyMap<string,Capability>,row:pg.QueryResultRow){const cap=registry.get(toolName(String(row.capability_id),String(row.tool_version)));return isGroupCompanyAgent(cap)&&row.binding_hash===cap!.bindingHash&&row.risk==='READ'&&row.provider_id==='MCP'&&row.connector_id===cap!.connectorId;}
function agentSurface(registry:ReadonlyMap<string,Capability>,history:ProviderMessage[],rows:pg.QueryResultRow[]){
 const calls=new Set<string>(),closed=new Set<string>();try{
  for(const m of history)for(const call of m.tool_calls??[]){const cap=registry.get(call.function.name);if(m.role!=='assistant'||call.type!=='function'||calls.has(call.id)||!isGroupCompanyAgent(cap)||!cap!.schema.safeParse(JSON.parse(call.function.arguments)).success)return false;calls.add(call.id);}
  for(const m of history)if(m.role==='tool'){if(!m.tool_call_id||!calls.has(m.tool_call_id)||closed.has(m.tool_call_id))return false;const result=JSON.parse(m.content!);if(result.data===undefined?!failure.safeParse(result).success:!agentTextResultContract.resultSchema.safeParse(result).success)return false;closed.add(m.tool_call_id);}
  return rows.every(row=>agentRow(registry,row));
 }catch{return false;}
}
/** A context contains one resource family. Two individually valid sources do
 * not imply permission to combine them in one model context or answer. */
export const certifiedGroupReadSurface=(r:ReadonlyMap<string,Capability>,h:ProviderMessage[],rows:pg.QueryResultRow[])=>groupCaseReadSurface(r,h,rows)||agentSurface(r,h,rows);
export function certifiedGroupReadCheckpoint(r:ReadonlyMap<string,Capability>,c:Checkpoint,rows:pg.QueryResultRow[]){
 if(groupCaseReadCheckpoint(r,c,rows))return true;
 return c.facts.every(f=>isGroupCompanyAgent(r.get(f.name))&&rows.some(row=>row.id===f.actionId&&agentRow(r,row)))&&c.actions.every(a=>a.capabilityId==='company.agent.ask'&&a.risk==='READ'&&rows.some(row=>row.id===a.id&&row.args_hash===a.argsHash&&row.state===a.state&&agentRow(r,row)))&&c.omitted.every(o=>['RESULT_NOT_VERIFIED','LEGACY_OR_MISSING_PROVENANCE','CURRENT_AUTHORIZATION_OR_SOURCE_CHANGED','INVALID_OR_UNAVAILABLE_PROVENANCE','CONTEXT_BUDGET'].includes(o.reason)&&rows.some(row=>row.id===o.actionId&&agentRow(r,row)))&&c.unexecutedCalls.every(call=>isGroupCompanyAgent(r.get(call.name)));
}
