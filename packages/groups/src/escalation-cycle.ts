import type {Database} from '../../storage/src/database.js';
import type {Vault} from '../../storage/src/crypto.js';
import {requiredSchema} from '../../storage/src/schema.js';
import {groupEscalationRuntimeProfile} from '../../config/src/group-escalation-runtime.js';
import type {DwsIdentities} from '../../dws/src/identity.js';
import type {DeliverySender} from '../../gateway/src/delivery.js';
import {GroupCaseRoster} from './case-roster.js';
import {GroupEscalations} from './escalations.js';
import {GroupEscalationRunner} from './escalation-runner.js';
/** Explicit finite operator entry; a profile narrows existing reviewed authority.
 * No enrollment, grant creation, scheduler registration, recovery or retry. */
export async function runReviewedGroupEscalationCycle(deps:{db:Database;vault:Vault;identities:DwsIdentities;sender:DeliverySender;binding:{corpId:string;robotCode:string;appOrigin:string}},raw:unknown,parent:AbortSignal){
 const p=groupEscalationRuntimeProfile.parse(raw),target=p.target;
 const current=()=>{parent.throwIfAborted();if(Date.now()<Date.parse(p.validFrom)||Date.now()>=Date.parse(p.expiresAt))throw Error('GROUP_ESCALATION_RUNTIME_EXPIRED');};
 current();if(p.requiredSchemaHash!==requiredSchema.contractHash||!await deps.db.ready())throw Error('GROUP_ESCALATION_RUNTIME_SCHEMA_CHANGED');
 if(deps.identities.runner?.transport!=='SIGNED_GROUP')throw Error('GROUP_ESCALATION_RUNTIME_SIGNED_SERVICE_REQUIRED');
 const boundedDb=deps.db.forkForAuthority(2,3000);let attempted=0;
 const check=async(dispatch:boolean)=>{current();return boundedDb.scope(target,async c=>{
  await c.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='2s'");
  const row=(await c.query('SELECT clock_timestamp() observed_at,e.* FROM group_case_escalations e WHERE e.id=$1 AND e.service_owner_id=$2',[target.proposalId,target.actorId])).rows[0];
  if(!row||row.tenant_id!==target.tenantId||row.group_id!==target.groupId||row.preview_hash!==target.previewHash||row.contract_hash!==target.contractHash||row.state!==(dispatch?'CLAIMED':'QUEUED')||new Date(row.observed_at).getTime()<Date.parse(p.validFrom)||new Date(row.observed_at).getTime()>=Date.parse(p.expiresAt)||new Date(row.expires_at).getTime()<=new Date(row.observed_at).getTime())throw Error('GROUP_ESCALATION_RUNTIME_TARGET_CHANGED');current();
 });};
 let roster:GroupCaseRoster|undefined,runner:GroupEscalationRunner|undefined;
 try{
  await check(false);const signal=AbortSignal.any([parent,AbortSignal.timeout(Math.max(1,Math.min(30000,Date.parse(p.expiresAt)-Date.now())))]);
  const sender:DeliverySender={sendReply:async()=>({state:'FAILED',reason:'GROUP_ESCALATION_REPLY_FORBIDDEN'}),sendProactive:async(to,text,active,beforePhysical)=>{
   if(attempted>=1||to.kind!=='GROUP'||to.externalId!==target.groupId||!beforePhysical)return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};
   const guard=async()=>{try{active.throwIfAborted();await check(true);return await beforePhysical();}catch{return false;}};
   if(!await guard())return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};attempted++;
   // Real sender invokes guard again after a cold token wait. The durable
   // proposal claim prevents another process/profile from refunding this cap.
   return deps.sender.sendProactive(to,text,active,guard);
  }};
  roster=new GroupCaseRoster(deps.identities,deps.binding.robotCode);runner=new GroupEscalationRunner(new GroupEscalations(deps.db,deps.vault,roster,deps.binding.robotCode),sender,deps.binding);
  const outcome=await runner.runOne(target,signal);return {mode:'FINITE_REVIEWED_GROUP_ESCALATION' as const,attempted,outcome:outcome.state,modelCalls:0 as const,automaticRepeat:false as const};
 }finally{await runner?.close();await roster?.close();await boundedDb.close();}
}
