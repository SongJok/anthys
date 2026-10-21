import type {Database} from '../../storage/src/database.js';
import type {Vault} from '../../storage/src/crypto.js';
import {groupReminderRuntimeProfile,type GroupReminderRuntimeTarget} from '../../config/src/group-reminder-runtime.js';
import type {DwsIdentities} from '../../dws/src/identity.js';
import {DeliveryGateway,type DeliverySender} from '../../gateway/src/delivery.js';
import {GroupReminderAudience} from './reminder-audience.js';
import {GroupReminderScheduler} from './reminder-runner.js';
import {GroupReminderVerifier} from './reminder-delivery.js';
/** Explicitly invoked, finite operator cycle. Never registered in default app
 * startup. This pin restricts already granted authority and cannot install it. */
export async function runReviewedGroupReminderCycle(deps:{db:Database;vault:Vault;identities:DwsIdentities;sender:DeliverySender;binding:{corpId:string;robotCode:string;appOrigin:string}},raw:unknown,signal:AbortSignal){
 const p=groupReminderRuntimeProfile.parse(raw);const current=()=>{signal.throwIfAborted();if(Date.now()<Date.parse(p.validFrom)||Date.now()>=Date.parse(p.expiresAt))throw Error('GROUP_REMINDER_RUNTIME_EXPIRED');};current();
 if(deps.identities.runner?.transport!=='SIGNED_GROUP')throw Error('GROUP_REMINDER_RUNTIME_SIGNED_SERVICE_REQUIRED');
 const check=async(t:GroupReminderRuntimeTarget)=>{current();return deps.db.scope(t,async c=>{
  const row=(await c.query("SELECT clock_timestamp() observed_at,s.id,s.owner_id,s.group_id,g.id authorization_id,g.document_hash,g.expires_at FROM group_reminder_schedules s JOIN group_reminder_authorizations g ON g.tenant_id=s.tenant_id AND g.id=s.authorization_id WHERE s.id=$1 AND public.oa_group_reminder_runtime_open(s.id)",[t.scheduleId])).rows[0];
  if(!row||new Date(row.observed_at as Date).getTime()<Date.parse(p.validFrom)||new Date(row.observed_at as Date).getTime()>=Date.parse(p.expiresAt)||row.owner_id!==t.actorId||row.group_id!==t.groupId||row.authorization_id!==t.authorizationId||row.document_hash!==t.authorizationHash||Date.parse(p.expiresAt)>new Date(row.expires_at as Date).getTime())throw Error('GROUP_REMINDER_RUNTIME_TARGET_CHANGED');
 });};
 // Validate every requested target before touching any queue. A mixed invalid
 // profile does not cause partial work for another recipient.
 for(const t of p.targets)await check(t);
 let attempted=0,processed=0;const outcomes:Record<string,number>={};
 for(const target of p.targets){current();if(attempted>=p.maxNotifications)break;await check(target);
  const audience=new GroupReminderAudience(deps.identities,deps.binding.robotCode),verifier=new GroupReminderVerifier(deps.vault,new GroupReminderAudience(deps.identities,deps.binding.robotCode),deps.binding.robotCode,target),scheduler=new GroupReminderScheduler(deps.db,deps.vault,audience,deps.binding.robotCode,[target.scheduleId]);
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(30000,Date.parse(p.expiresAt)-Date.now())))]);
  // The real sender calls this wrapper after OAuth too. Persisted SENDING,
  // UNKNOWN and previous outcomes conservatively consume the finite profile
  // cap across process restarts; replacing the process cannot refund it.
  const sender:DeliverySender={sendReply:async()=>({state:'FAILED',reason:'GROUP_REMINDER_REPLY_FORBIDDEN'}),sendProactive:async(to,text,active,beforePhysical)=>{
   current();if(to.kind!=='GROUP'||to.externalId!==target.groupId||!beforePhysical)return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};
   const guard=async()=>{try{await check(target);const used=await deps.db.scope(target,async c=>Number((await c.query("SELECT count(*) n FROM group_reminder_notifications n JOIN deliveries d ON d.tenant_id=n.tenant_id AND d.id=n.delivery_id WHERE n.group_id=$1 AND d.state IN ('SENDING','APPLIED_UNVERIFIED','UNKNOWN','FAILED','SUPPRESSED') AND (d.sending_at>=$2 OR d.state IN ('SENDING','UNKNOWN'))",[target.groupId,p.validFrom])).rows[0].n));current();return used<=p.maxNotifications&&await beforePhysical();}catch{return false;}};
   if(!await guard())return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};attempted++;return deps.sender.sendProactive(to,text,active,guard);
  }};
  try{
   await scheduler.tick(target,bounded);await check(target);const gateway=new DeliveryGateway(deps.db,deps.vault,sender,deps.binding,Date.now,undefined,verifier);
   const ids=await deps.db.scope(target,async c=>(await c.query("SELECT d.id FROM deliveries d JOIN group_reminder_occurrences o ON o.tenant_id=d.tenant_id AND o.delivery_id=d.id WHERE o.schedule_id=$1 AND d.state='PENDING' AND d.next_at<=clock_timestamp() ORDER BY d.next_at,d.id LIMIT $2",[target.scheduleId,p.maxNotifications])).rows.map(r=>r.id as string));
   for(const id of ids){current();if(attempted>=p.maxNotifications)break;const result=await gateway.process(target,id,bounded);outcomes[result]=(outcomes[result]??0)+1;processed++;}
  }finally{await audience.close();await verifier.close();}
 }
 return {mode:'FINITE_REVIEWED_GROUP_REMINDER_CYCLE' as const,processed,attempted,outcomes,modelCalls:0 as const,automaticRepeat:false as const};
}
