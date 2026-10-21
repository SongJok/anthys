import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import type {RuntimeStore} from '../../runtime/src/store.js';
import {groupAudienceContextSchema} from '../../runtime/src/lease-contract.js';
import type {AgentRequestRow,AgentRequestClaim} from './agent-requests.js';
/** Load an immutable audience context from actual persisted rows. No lease,
 * RUNNING status, worker identity or model authority is synthesized. */
export async function companyAgentGroupContext(c:pg.PoolClient,ctx:DbContext,row:AgentRequestRow){
 const r=(await c.query(`SELECT r.budget,t.goal,t.auth_epoch,t.audience,to_char(t.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') expires_text,a.id,a.proof_hash
 FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id JOIN run_group_audiences a ON a.tenant_id=r.tenant_id AND a.id=r.group_audience_id AND a.run_id=r.id AND a.task_id=t.id AND a.owner_id=r.owner_id
 WHERE r.id=$1 AND r.task_id=$2 AND r.owner_id=$3 AND a.id=$4 AND t.audience=$5::jsonb AND t.auth_epoch=$6 AND r.provider_session_no=$7 AND a.expires_at>clock_timestamp()`,[row.run_id,row.task_id,ctx.actorId,row['group_audience_id'],JSON.stringify(row.audience),row.auth_epoch,row.provider_session_no])).rows[0];
 if(!r)throw Error('AGENT_GROUP_CONTEXT_UNAVAILABLE');
 return groupAudienceContextSchema.parse({runId:row.run_id,taskId:row.task_id,goal:r.goal,authEpoch:Number(r.auth_epoch),policyVersion:row.policy_version,expiresAt:r.expires_text,budget:r.budget,audience:r.audience,groupAudience:{id:r.id,hash:r.proof_hash}});
}
/** One fresh roster observation per exact background claim, then a short local
 * dispatch gate. Restarted workers must observe again; this is no authority
 * cache and cannot mint a durable dispatch or result delivery. */
export function companyAgentGroupObserver(store:RuntimeStore){
 const prepared=new Map<string,{worker:string;fence:number;at:number}>();
 const observe=async(ctx:DbContext,claim:AgentRequestClaim,row:AgentRequestRow,parent:AbortSignal)=>{
  prepared.delete(row.id);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);timer.unref();const signal=AbortSignal.any([parent,controller.signal]);
  try{
   if(claim.id!==row.id)throw Error('AGENT_GROUP_AUDIENCE_CHANGED');
   if(!store.groupAudiences)throw Error('AGENT_GROUP_AUDIENCE_UNAVAILABLE');
   const allowed=await store.db.scope(ctx,async c=>{await c.query("SET LOCAL statement_timeout='12000ms'; SET LOCAL lock_timeout='1000ms'");const context=await companyAgentGroupContext(c,ctx,row);return store.groupAudiences!.currentWaiting(c,ctx,{context,requestId:row.id,workerId:claim.workerId,requestFence:claim.fence},signal);});
   signal.throwIfAborted();if(!allowed)throw Error('AGENT_GROUP_AUDIENCE_CHANGED');
   if(prepared.size>=128)prepared.clear();prepared.set(row.id,{worker:claim.workerId,fence:claim.fence,at:performance.now()});
  }finally{clearTimeout(timer);}
 };
 const dispatch=async(_c:pg.PoolClient,_ctx:DbContext,row:AgentRequestRow,signal:AbortSignal)=>{
  signal.throwIfAborted();const value=prepared.get(row.id);prepared.delete(row.id);
  return !!value&&value.worker===row.worker_id&&value.fence===Number(row.fence)&&performance.now()-value.at<=2000;
 };
 return {observe,dispatch};
}
