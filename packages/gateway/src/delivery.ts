import type {GroupReminderVerifier} from '../../groups/src/reminder-delivery.js';
import type {GroupEscalationVerifier} from '../../groups/src/escalation-delivery.js';
import {killed} from './controls.js';
import {appendAudit} from '../../storage/src/audit.js';
import {stageTaskReceipts} from '../../dingtalk/src/task-receipt.js';
import {trialState,watchTrial} from '../../storage/src/trial.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database,DbContext} from '../../storage/src/database.js';
import {Vault,type Sealed} from '../../storage/src/crypto.js';
import type {SendResult} from '../../dingtalk/src/sender.js';
import {attachmentDependenciesAllowed,classificationLevels} from '../../attachments/src/egress.js';
import {finalDeliveryAllowed,groupNarrativeDelivery,type FinalSourceCheck} from './final-delivery.js';
export interface DeliverySender {
 sendReply(reply:{url:string;expiresAt:number},text:string,signal:AbortSignal,beforePhysical?:()=>Promise<boolean>):Promise<SendResult>;
 sendProactive(target:{kind:'PRIVATE_USER'|'GROUP';externalId:string},text:string,signal:AbortSignal,beforePhysical?:()=>Promise<boolean>):Promise<SendResult>;
}
const inboxReply=z.object({chatbotCorpId:z.string(),robotCode:z.string(),senderStaffId:z.string(),conversationId:z.string(),conversationType:z.enum(['1','2']),sessionWebhook:z.url().optional(),sessionWebhookExpiredTime:z.number().optional()});
export class DeliveryGateway {
 constructor(private db:Database,private vault:Vault,private sender:DeliverySender,private binding:{corpId:string;robotCode:string;appOrigin:string},private clock:()=>number=Date.now,private finalSources?:FinalSourceCheck,private groupReminders?:Pick<GroupReminderVerifier,'deliveryAllowed'>,private groupEscalations?:Pick<GroupEscalationVerifier,'deliveryAllowed'>){}
 private async auditClosedTrial(c:import('pg').PoolClient,ctx:DbContext,taskId?:string):Promise<void>{
  if(!taskId)return;
  // oa_trial_check can close an orphan inside PostgreSQL before this sender
  // claims it. Observe that committed decision without reviving any delivery.
  const rows=await c.query("SELECT id,attempt_key,state FROM deliveries WHERE task_id=$1 AND state IN ('UNKNOWN','SUPPRESSED') ORDER BY id FOR UPDATE",[taskId]);
  for(const row of rows.rows)await appendAudit(c,ctx,{action:'delivery.finished',resource:row.id as string,result:row.state as 'UNKNOWN'|'SUPPRESSED',traceId:(row.attempt_key??row.id) as string},true);
 }
 async pending(ctx:DbContext):Promise<string[]> {return this.db.scope(ctx,async c=>{
  const trial=await trialState(c,undefined,true);if(trial.restricted&&!trial.allowed){await this.auditClosedTrial(c,ctx,trial.taskId);return [];}
  if(!trial.restricted||trial.mode==='FORMAL')await stageTaskReceipts(c,ctx,this.vault);
  // A previously claimed write may have applied. Never put it back in PENDING.
  const expired=await c.query("UPDATE deliveries SET state='UNKNOWN',last_error='SENDER_LEASE_EXPIRED' WHERE public.oa_lifecycle_run_allowed(source_run_id) AND state='SENDING' AND sending_at<now()-interval '60 seconds' RETURNING id,attempt_key");
  for(const row of expired.rows)await appendAudit(c,ctx,{action:'delivery.finished',resource:row.id as string,result:'UNKNOWN',traceId:(row.attempt_key??row.id) as string},true);
  const q=await c.query("SELECT d.id FROM deliveries d JOIN tasks t ON t.tenant_id=d.tenant_id AND t.id=d.task_id WHERE public.oa_lifecycle_run_allowed(d.source_run_id) AND d.state='PENDING' AND d.next_at<=now() AND (t.control_kind IS DISTINCT FROM 'GROUP_ESCALATION' OR $1) ORDER BY d.next_at,d.id LIMIT 50",[!!this.groupEscalations]);return q.rows.map(r=>r.id as string);
 });}
 private async allowed(ctx:DbContext,id:string,attempt:string,signal?:AbortSignal){return this.db.scope(ctx,async c=>{
  const q=await c.query("SELECT d.*,t.status task_status,t.cancel_requested_at,t.auth_epoch,u.auth_epoch current_auth_epoch,u.status user_status,u.external_user_id,corp.corp_id,corp.status tenant_status,corp.policy_version current_policy_version,t.expires_at,t.audience,t.goal,coalesce(t.reply_event_id,t.source_event_id) source_event_id,t.control_kind FROM deliveries d JOIN tasks t ON t.tenant_id=d.tenant_id AND t.id=d.task_id JOIN users u ON u.tenant_id=d.tenant_id AND u.id=d.owner_id JOIN tenants corp ON corp.tenant_id=d.tenant_id WHERE d.id=$1 AND d.attempt_key=$2 AND d.state='SENDING'",[id,attempt]);
  // Migration 022 pairs run/session nullability; an unbound legacy row has
  // neither. A half-bound row is rejected by PostgreSQL before reaching here.
  const r=q.rows[0];if(!r||!r.source_run_id)return null;
  const trial=await trialState(c,r.source_run_id as string);if(trial.restricted&&(!trial.allowed||r.task_id!==trial.taskId))return null;
  const finitePrivatePilot=(await c.query('SELECT public.oa_finite_private_pilot_active($1,NULL) active',[r.source_run_id])).rows[0].active===true;
  if(!r.finalization_id&&finitePrivatePilot)return null;
  const earlyReceipt=!r.finalization_id&&!r.control_kind;
  if(r.cancel_requested_at||!['ACTIVE','COMPLETED',...(earlyReceipt?['OPEN']:[])].includes(r.task_status as string)||r.user_status!=='ACTIVE'||r.tenant_status!=='ACTIVE'||String(r.auth_epoch)!==String(r.current_auth_epoch)||r.corp_id!==this.binding.corpId||new Date(r.expires_at as string).getTime()<=this.clock())return null;
  if(await killed(c,ctx,{taskId:r.task_id as string,audience:r.audience as Record<string,unknown>},'DINGTALK_API',true,r.target as Record<string,unknown>))return null;
  const ceiling=z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']),targetResult=z.object({kind:z.enum(['PRIVATE_USER','GROUP']),targetId:z.string(),classificationCeiling:ceiling}).passthrough().safeParse(r.target),currentResult=z.object({kind:z.string(),targetId:z.string(),classificationCeiling:ceiling}).passthrough().safeParse(r.audience);if(!targetResult.success||!currentResult.success)return null;const target=targetResult.data,current=currentResult.data;
  const rank=classificationLevels.indexOf(r.classification as string);if(rank<0||rank>classificationLevels.indexOf(target.classificationCeiling)||rank>classificationLevels.indexOf(current.classificationCeiling))return null;
  if(target.kind!==current.kind||target.targetId!==current.targetId)return null;
  if(target.kind==='PRIVATE_USER'&&target.targetId!==ctx.actorId)return null;
  if(!await attachmentDependenciesAllowed(c,ctx,r.task_id as string,{runId:r.source_run_id as string,sessionNo:Number(r.source_session_no)}))return null;
  const groupReminder=target.kind==='GROUP'&&r.control_kind==='GROUP_REMINDER';
  const groupEscalation=target.kind==='GROUP'&&r.control_kind==='GROUP_ESCALATION';
  if(groupEscalation?!(this.groupEscalations&&await this.groupEscalations.deliveryAllowed(c,ctx,r,signal)):groupReminder?!(this.groupReminders&&await this.groupReminders.deliveryAllowed(c,ctx,r,signal)):!await finalDeliveryAllowed(c,ctx,this.vault,r,this.finalSources))return null;
  const trialCurrent=await trialState(c,r.source_run_id as string);if(trialCurrent.restricted&&!trialCurrent.allowed)return null;
  return {...r,target,finite_private_pilot:finitePrivatePilot,group_proactive_authorized:groupReminder||groupEscalation,group_narrative:target.kind==='GROUP'&&!groupReminder&&!groupEscalation&&await groupNarrativeDelivery(c,ctx,this.vault,r)};
 });}
 async process(ctx:DbContext,id:string,signal:AbortSignal):Promise<string>{
  const trial=await this.db.scope(ctx,async c=>{const state=await trialState(c,undefined,true);if(state.restricted&&!state.allowed)await this.auditClosedTrial(c,ctx,state.taskId);return state;});
  if(!trial.restricted)return this.processInner(ctx,id,signal,false);
  if(!trial.allowed)return 'NOT_CLAIMED';
  const runId=trial.mode==='FORMAL'?await this.db.scope(ctx,async c=>(await c.query('SELECT source_run_id FROM deliveries WHERE id=$1 AND public.oa_lifecycle_run_allowed(source_run_id)',[id])).rows[0]?.source_run_id as string|undefined):trial.runId;
  if(!runId)return 'NOT_CLAIMED';
  const watcher=await watchTrial(this.db,ctx,runId);
  try{
   const result=await this.processInner(ctx,id,AbortSignal.any([signal,watcher.signal]),trial.mode!=='FORMAL');
   if(trial.mode!=='FORMAL'&&result!=='NOT_CLAIMED')await this.db.scope(ctx,c=>trialState(c,trial.runId,false,result==='APPLIED_UNVERIFIED'?'TRIAL_DELIVERED':result==='UNKNOWN'?'TRIAL_DELIVERY_UNKNOWN':'TRIAL_DELIVERY_STOPPED'));
   return result;
  }finally{await watcher.stop();}
 }
 private async processInner(ctx:DbContext,id:string,signal:AbortSignal,restricted:boolean):Promise<string>{
  const attempt=randomUUID();
  const claimed=await this.db.scope(ctx,async c=>{const q=await c.query("UPDATE deliveries SET state='SENDING',attempt_key=$2,sending_at=now(),version=version+1 WHERE id=$1 AND public.oa_lifecycle_run_allowed(source_run_id) AND state='PENDING' AND next_at<=now() RETURNING id",[id,attempt]);if(q.rowCount)await appendAudit(c,ctx,{action:'delivery.claimed',resource:id,result:'SENDING',traceId:attempt});return !!q.rowCount;});
  if(!claimed)return 'NOT_CLAIMED';
  let outcome:SendResult,sourceRunId:string|undefined;
  try{
   let row=await this.allowed(ctx,id,attempt,signal);if(!row){await this.suppress(ctx,id,attempt,'AUTHORIZATION_OR_SOURCE_UNVERIFIED');return 'SUPPRESSED';}
   sourceRunId=row.source_run_id as string;
   const content=this.vault.open(JSON.parse(row.content_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:delivery:${id}`);
   let reply:z.infer<typeof inboxReply>|null=null;
   if(row.source_event_id){const q=await this.db.scope(ctx,c=>c.query("SELECT payload_cipher_ref FROM event_inbox WHERE id=$1 AND source='DINGTALK'",[row.source_event_id]));if(q.rowCount)reply=inboxReply.parse(JSON.parse(this.vault.open(JSON.parse(q.rows[0].payload_cipher_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:inbox:${row.source_event_id}`)));}
   if(reply&&(reply.chatbotCorpId!==this.binding.corpId||reply.robotCode!==this.binding.robotCode||reply.senderStaffId!==row.external_user_id||(row.target.kind==='GROUP'&&(reply.conversationType!=='2'||reply.conversationId!==row.target.targetId)))){await this.suppress(ctx,id,attempt,'REPLY_IDENTITY_MISMATCH');return 'SUPPRESSED';}
   // Only a current group audience plus admitted source-free narrative may be
   // sent verbatim here. Business REPORT still receives a minimal group status.
   let text=row.target.kind==='GROUP'&&!row.group_narrative&&!row.group_proactive_authorized?(['CLARIFICATION_REPLY','PERSONA'].includes(row.control_kind as string)?content:row.control_kind==='STOP'?`停止请求已收到。请发起人在个人工作台查看是否需要选择任务及处理状态；在途外部动作仍须核对。本次信息来源仅为 @机器人消息。`:`任务 ${String(row.task_id)} 已处理。详细结果仅发起人可在工作台查看；本次信息来源仅为 @机器人消息。`):content;
   const webhook=reply?.sessionWebhook,expiresAt=reply?.sessionWebhookExpiredTime??0;
   if(row.finite_private_pilot&&(!webhook||expiresAt<=this.clock())){await this.suppress(ctx,id,attempt,'FINITE_PILOT_REPLY_REQUIRED');return 'SUPPRESSED';}
   if(restricted&&(!webhook||expiresAt<=this.clock())){await this.suppress(ctx,id,attempt,'TRIAL_REPLY_REQUIRED');return 'SUPPRESSED';}
   if(row.target.kind==='GROUP'&&!row.group_proactive_authorized&&(!webhook||expiresAt<=this.clock())){await this.suppress(ctx,id,attempt,'GROUP_PROACTIVE_AUTH_REQUIRED');return 'SUPPRESSED';}
   signal.throwIfAborted();row=await this.allowed(ctx,id,attempt,signal);if(!row){await this.suppress(ctx,id,attempt,'AUTHORIZATION_OR_SOURCE_UNVERIFIED');return 'SUPPRESSED';}
   if(row.group_narrative||row.group_proactive_authorized)text=content;
   if(row.target.kind==='PRIVATE_USER'&&row.finalization_id)text=`任务 ${String(row.task_id)}\n\n${content}`;
   const dispatched=row;const beforePhysical=async()=>{signal.throwIfAborted();
    // Spend the permanent finite slot before the final authority observation.
    // Waiting for that transaction must never make an earlier proof the last check.
    if(dispatched.finite_private_pilot&&!await this.db.scope(ctx,async c=>(await c.query('SELECT public.oa_finite_private_pilot_message($1,$2) allowed',[id,attempt])).rows[0].allowed===true))return false;
    const current=await this.allowed(ctx,id,attempt,signal);return !!current&&current.content_ref===dispatched.content_ref&&current.source_run_id===dispatched.source_run_id&&current.source_session_no===dispatched.source_session_no&&current.task_id===dispatched.task_id&&current.args_hash===dispatched.args_hash&&current.finalization_id===dispatched.finalization_id&&JSON.stringify(current.target)===JSON.stringify(dispatched.target);};
   if(row.finite_private_pilot){
    if(!webhook||expiresAt<=this.clock()){await this.suppress(ctx,id,attempt,'FINITE_PILOT_REPLY_REQUIRED');return 'SUPPRESSED';}
    outcome=await this.sender.sendReply({url:webhook,expiresAt},text,signal,beforePhysical);
   }else if(webhook&&expiresAt>this.clock())outcome=await this.sender.sendReply({url:webhook,expiresAt},text,signal,beforePhysical);
   else if(row.group_proactive_authorized)outcome=await this.sender.sendProactive({kind:'GROUP',externalId:row.target.targetId},text,signal,beforePhysical);
   else outcome=await this.sender.sendProactive({kind:'PRIVATE_USER',externalId:row.external_user_id as string},text,signal,beforePhysical);
  }catch{outcome={state:'UNKNOWN',reason:'DELIVERY_INTERRUPTED_RECONCILE_REQUIRED'};}
  if(outcome.state==='FAILED'&&outcome.reason==='AUTHORIZATION_UNVERIFIED_BEFORE_SEND'){await this.suppress(ctx,id,attempt,outcome.reason);return 'SUPPRESSED';}
  const erased=await this.db.scope(ctx,async c=>{
   // The send is already in flight. Do not hold the erasure barrier over the
   // network; serialize late receipt retention with deletion instead. Bind to
   // the source of the bytes actually loaded before dispatch, not restored IDs.
   await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended(current_setting('app.tenant_id',true)::uuid::text||':memory:'||current_setting('app.actor_id',true)::uuid::text,0))");
   const known=(await c.query('SELECT public.oa_run_content_erased(coalesce($3::uuid,(SELECT source_run_id FROM deliveries WHERE id=$1 AND attempt_key=$2))) erased',[id,attempt,sourceRunId??null])).rows[0]?.erased;
   if(known!==false){
    const updated=await c.query("UPDATE deliveries SET content_ref='{}',state=CASE WHEN state='SENDING' THEN 'UNKNOWN' WHEN state IN ('PENDING','FAILED') THEN 'SUPPRESSED' ELSE state END,message_id=coalesce($3,message_id),external_request_id=coalesce($4,external_request_id),last_error='PRIVATE_CONTEXT_ERASED_AFTER_DISPATCH',verification_state='UNVERIFIED',verification_method='PROVIDER_ACCEPTANCE_ONLY',updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND attempt_key=$2 RETURNING state",[id,attempt,outcome.externalMessageId??null,outcome.requestId??null]);
    if(updated.rowCount)await appendAudit(c,ctx,{action:'delivery.finished',resource:id,result:updated.rows[0].state as 'UNKNOWN'|'SUPPRESSED'|'APPLIED_UNVERIFIED',traceId:attempt},true);return true;
   }
   const updated=await c.query("UPDATE deliveries SET state=$3,message_id=$4,external_request_id=$5,last_error=$6,verification_state='UNVERIFIED',verification_method='PROVIDER_ACCEPTANCE_ONLY',updated_at=now(),version=version+1 WHERE id=$1 AND attempt_key=$2 AND state='SENDING' RETURNING id",[id,attempt,outcome.state,outcome.externalMessageId??null,outcome.requestId??null,outcome.reason??null]);
   if(updated.rowCount)await appendAudit(c,ctx,{action:'delivery.finished',resource:id,result:outcome.state,traceId:attempt},true);return false;
  });
  return erased?'UNKNOWN':outcome.state;
 }
 private async suppress(ctx:DbContext,id:string,attempt:string,reason:string):Promise<void>{await this.db.scope(ctx,async c=>{const updated=await c.query("UPDATE deliveries SET state='SUPPRESSED',last_error=$3,version=version+1 WHERE id=$1 AND attempt_key=$2 AND state='SENDING' RETURNING id",[id,attempt,reason]);if(updated.rowCount)await appendAudit(c,ctx,{action:'delivery.finished',resource:id,result:'SUPPRESSED',traceId:attempt},true);});}
}
