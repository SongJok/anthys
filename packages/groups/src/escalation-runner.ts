import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {DeliveryGateway,type DeliverySender} from '../../gateway/src/delivery.js';
import {GroupEscalations} from './escalations.js';
import {GroupEscalationVerifier,type GroupEscalationTarget} from './escalation-delivery.js';
import {renderGroupEscalationNotification} from './escalation-proof.js';
/** One exact durable queue claim, no polling, automatic recovery or send retry.
 * The caller supplies an independently approved finite target configuration. */
export class GroupEscalationRunner{
 private readonly execution:GroupEscalations;
 constructor(readonly host:GroupEscalations,readonly sender:DeliverySender,readonly binding:{corpId:string;robotCode:string;appOrigin:string}){
  // This separate pool also bounds the gateway's short SQL operations, without
  // changing other runtime users or holding a SQL lock over token acquisition.
  this.execution=new GroupEscalations(host.db.forkForAuthority(4,3000),host.vault,host.roster,host.robotCode);
 }
 private async transaction<T>(ctx:DbContext,signal:AbortSignal|undefined,fn:(c:pg.PoolClient)=>Promise<T>){
  signal?.throwIfAborted();return this.execution.db.scope(ctx,async c=>{await c.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='2s'");signal?.throwIfAborted();const value=await fn(c);signal?.throwIfAborted();return value;});
 }
 async close(){await this.execution.db.close();}
 async runOne(target:GroupEscalationTarget,parent:AbortSignal){
  const signal=AbortSignal.any([parent,AbortSignal.timeout(30000)]),ctx:DbContext={tenantId:target.tenantId,actorId:target.actorId},claimId=randomUUID(),host=this.execution;
  if(signal.aborted)return {state:'STOPPED_NOT_STARTED' as const};
  let claim:pg.QueryResultRow;
  try{
   const prior=await this.transaction(ctx,signal,async c=>(await c.query('SELECT id FROM group_case_escalations WHERE id=$1 AND service_owner_id=$2 AND group_id=$3 AND preview_hash=$4 AND contract_hash=$5',[target.proposalId,ctx.actorId,target.groupId,target.previewHash,target.contractHash])).rows[0]);
   if(!prior)return {state:'NOT_FOUND' as const};
   claim=await this.transaction(ctx,signal,async c=>(await c.query('SELECT public.oa_group_escalation_claim($1,$2,$3) value',[target.proposalId,target.previewHash,claimId])).rows[0].value);
   if(!claim)return {state:'NOT_CLAIMED' as const};
   if(claim.state!=='CLAIMED')return {state:claim.state as string};
  }catch{return {state:'UNKNOWN' as const};}
  try{
   signal.throwIfAborted();const proof=host.open(claim);
   if(!await host.verifyPersisted(proof,signal))throw Error('GROUP_ESCALATION_SOURCE_CHANGED');
   signal.throwIfAborted();const body=renderGroupEscalationNotification(proof.preview),taskId=randomUUID(),runId=randomUUID(),deliveryId=randomUUID();
   await this.transaction(ctx,signal,c=>c.query('SELECT public.oa_group_escalation_stage($1,$2,$3,$4,$5,$6,$7,$8)',[target.proposalId,claimId,taskId,runId,deliveryId,body,JSON.stringify(host.vault.seal(body,`${ctx.tenantId}:${ctx.actorId}:delivery:${deliveryId}`)),hash(body)]));
   const verifier=new GroupEscalationVerifier(host,target),gateway=new DeliveryGateway(host.db,host.vault,this.sender,this.binding,Date.now,undefined,undefined,verifier);
   signal.throwIfAborted();await gateway.process(ctx,deliveryId,signal);
  }catch{
   // The claim or publication may have committed. Never enqueue/reclaim/send
   // again from an exception, including a lost COMMIT acknowledgment.
  }
  try{
   // Local reconciliation is bounded separately even after the caller stops.
   const row=await this.transaction(ctx,undefined,async c=>(await c.query('SELECT public.oa_group_escalation_settle($1,$2) value',[target.proposalId,claimId])).rows[0].value);
   return {state:row.state as string};
  }catch{return {state:'UNKNOWN' as const};}
 }
}
