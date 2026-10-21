import type {GroupReminderRuntimeTarget} from '../../config/src/group-reminder-runtime.js';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {GroupReminderAudience,type GroupReminderOrigin} from './reminder-audience.js';
import {groupReminderProof,groupReminderTarget,observerAuthorityHash,reminderDefinition,reminderContract,registeredReminderCases,reminderUsage,reminderCandidate,renderGroupReminder} from './reminder-proof.js';
/** The sole proof oracle for a source-free proactive group reminder. Generic
 * GROUP delivery remains denied. A signed roster response alone grants nothing. */
export class GroupReminderVerifier{
 constructor(readonly vault:Vault,readonly audience:GroupReminderAudience,readonly robotCode:string,private readonly target?:GroupReminderRuntimeTarget){}
 async close(){await this.audience.close();}
 private async load(c:pg.PoolClient,ctx:DbContext,deliveryId:string|null,runId:string|null){
  const row=(await c.query("SELECT n.*,o.fence,o.scheduled_at,o.expires_at,o.task_id,o.run_id,d.content_ref,d.target,d.classification,d.source_session_no,d.args_hash,d.finalization_id,d.source_run_id,r.result,r.budget,t.audience,t.goal FROM group_reminder_notifications n JOIN group_reminder_occurrences o ON o.tenant_id=n.tenant_id AND o.id=n.occurrence_id AND o.notification_id=n.id AND o.owner_id=n.owner_id AND o.delivery_id=n.delivery_id JOIN deliveries d ON d.tenant_id=o.tenant_id AND d.id=o.delivery_id AND d.owner_id=o.owner_id AND d.task_id=o.task_id AND d.source_run_id=o.run_id JOIN tasks t ON t.tenant_id=o.tenant_id AND t.id=o.task_id AND t.requester_id=o.owner_id JOIN runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id AND r.task_id=o.task_id AND r.owner_id=o.owner_id WHERE n.owner_id=$3 AND ($1::uuid IS NULL OR n.delivery_id=$1) AND ($2::uuid IS NULL OR o.run_id=$2) AND o.state='STAGED' AND o.expires_at>clock_timestamp() AND t.expires_at=o.expires_at AND t.control_kind='GROUP_REMINDER' AND t.status='COMPLETED' AND t.cancel_requested_at IS NULL AND t.source_event_id IS NULL AND t.reply_event_id IS NULL AND r.status='SUCCEEDED' AND r.result_classification='INTERNAL' AND r.provider_session_no=1 AND r.model_turns=0 AND r.tool_calls=0 AND r.persona_snapshot_id IS NULL AND d.source_session_no=1 AND d.finalization_id IS NULL AND EXISTS(SELECT 1 FROM outbox b WHERE b.tenant_id=o.tenant_id AND b.owner_id=o.owner_id AND b.kind='GROUP_REMINDER' AND b.aggregate_id=o.id AND b.published_at IS NOT NULL)",[deliveryId,runId,ctx.actorId])).rows[0];
  if(!row||row.tenant_id!==ctx.tenantId||row.classification!=='INTERNAL'||row.goal!=='确定性群催办摘要'||canonical(row.budget)!==canonical({schemaVersion:1,maxTurns:0,maxTools:0,maxActiveMs:1})||canonical(row.target)!==canonical(groupReminderTarget(row.group_id as string))||canonical(row.target)!==canonical(row.audience))return null;
  const text=this.vault.open(row.proof_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:group-reminder-notification:${row.id}`);if(hash(text)!==row.proof_hash)return null;
  const proof=groupReminderProof.parse(JSON.parse(text)),body=this.vault.open(JSON.parse(row.content_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:delivery:${row.delivery_id}`);
  if(proof.contentHash!==row.content_hash||hash(body)!==proof.contentHash||body!==row.result||proof.originHash!==row.origin_hash||proof.items.length!==Number(row.item_count)||row.args_hash!==hash(canonical({notificationId:row.id,originHash:row.origin_hash,contentHash:proof.contentHash})))return null;
  const cases=(await c.query('SELECT case_id,case_version,resource_hash FROM group_reminder_notification_cases WHERE notification_id=$1 ORDER BY case_id',[row.id])).rows;
  if(cases.length!==proof.items.length||cases.some(item=>{const expected=proof.items.find(i=>i.id===item.case_id);return !expected||expected.version!==Number(item.case_version)||hash(expected.resourceRef)!==item.resource_hash;}))return null;return {row,proof,body};
 }
 private async current(c:pg.PoolClient,ctx:DbContext,data:NonNullable<Awaited<ReturnType<GroupReminderVerifier['load']>>>,signal:AbortSignal){
  const {row,proof,body}=data,origin:GroupReminderOrigin={occurrenceId:row.occurrence_id as string,fence:Number(row.fence),phase:'SEND'},before=await this.audience.observe(c,ctx,row.group_id as string,origin,signal),o=before.observer;
  if(this.target&&(ctx.tenantId!==this.target.tenantId||ctx.actorId!==this.target.actorId||o.groupId!==this.target.groupId||o.schedule.id!==this.target.scheduleId||o.authorization.id!==this.target.authorizationId||o.authorization.documentHash!==this.target.authorizationHash))return false;
  if(o.originHash!==proof.originHash||o.occurrence.notificationId!==row.id||o.schedule.definitionHash!==proof.definitionHash||observerAuthorityHash(o)!==proof.authorityHash||before.membershipHash!==proof.membershipHash||o.contractId!==row.contract_id||o.contractVersion!==Number(row.contract_version)||o.contractHash!==row.contract_hash||renderGroupReminder(proof.items,o,new Date(row.scheduled_at as Date).toISOString(),proof.omitted)!==body)return false;
  const definition=await reminderDefinition(c,ctx,this.vault,o),usage=reminderUsage((await c.query('SELECT public.oa_group_reminder_send_usage($1,$2) value',[origin.occurrenceId,origin.fence])).rows[0].value),contract=await reminderContract(c,ctx,this.vault,o,definition,Date.parse(usage.until)),registered=await registeredReminderCases(c,ctx,this.vault,o,origin,contract,this.robotCode);
  if(registered.hash!==proof.caseSourceHash||Date.parse(proof.selectionAt)>Date.parse(usage.until)||proof.items.some(i=>!registered.items.some(r=>canonical(i)===canonical(r))))return false;
  // Existing own reservation is excluded only by the SQL oracle. All other
  // owners, old contracts, UNKNOWNs and pending notifications still consume quota.
  const plan=reminderCandidate(proof.items,contract,o,usage,before.members);
  if(plan.status!=='CANDIDATE'||plan.digest?.items.length!==proof.items.length||plan.digest.items.some(i=>!proof.items.some(p=>p.id===i.id&&p.version===i.version)))return false;
  const after=await this.audience.observe(c,ctx,o.groupId,origin,signal,o);return after.membershipHash===proof.membershipHash&&(await registeredReminderCases(c,ctx,this.vault,o,origin,contract,this.robotCode)).hash===proof.caseSourceHash;
 }
 async deliveryAllowed(c:pg.PoolClient,ctx:DbContext,delivery:Record<string,unknown>,signal?:AbortSignal){try{
  if(delivery.control_kind!=='GROUP_REMINDER'||delivery.source_event_id||delivery.finalization_id||typeof delivery.id!=='string')return false;
  const data=await this.load(c,ctx,delivery.id,null);if(!data||data.row.task_id!==delivery.task_id||data.row.source_run_id!==delivery.source_run_id||data.row.content_ref!==delivery.content_ref||canonical(data.row.target)!==canonical(delivery.target))return false;
  return await this.current(c,ctx,data,signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000));
 }catch{return false;}}
 async resultAllowed(c:pg.PoolClient,ctx:DbContext,runId:string,result:string,signal?:AbortSignal){try{const data=await this.load(c,ctx,null,runId);return !!data&&data.body===result&&await this.current(c,ctx,data,signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000));}catch{return false;}}
}
