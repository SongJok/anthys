import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {hash,type Sealed} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {GroupEscalations} from './escalations.js';
import {renderGroupEscalationNotification} from './escalation-proof.js';
export type GroupEscalationTarget={tenantId:string;actorId:string;groupId:string;proposalId:string;previewHash:string;contractHash:string};
/** Independent oracle for one explicit escalation, never a generic group or
 * reminder grant. The finite runner may additionally pin one exact target. */
export class GroupEscalationVerifier{
 constructor(readonly host:GroupEscalations,private readonly target?:GroupEscalationTarget){}
 private async local(c:pg.PoolClient,ctx:DbContext,delivery:Record<string,unknown>){
  if(delivery.control_kind!=='GROUP_ESCALATION'||delivery.source_event_id||delivery.finalization_id||delivery.classification!=='INTERNAL'||Number(delivery.source_session_no)!==1)return null;
  const row=(await c.query("SELECT e.*,r.result,r.budget,r.model_turns,r.tool_calls,r.persona_snapshot_id,r.persona_context_state,t.goal,t.status task_status,t.cancel_requested_at,t.audience FROM group_case_escalations e JOIN runs r ON r.tenant_id=e.tenant_id AND r.id=e.run_id AND r.owner_id=e.service_owner_id JOIN tasks t ON t.tenant_id=e.tenant_id AND t.id=e.task_id AND t.requester_id=e.service_owner_id WHERE e.delivery_id=$1 AND e.service_owner_id=$2 AND r.status='SUCCEEDED' AND r.result_classification='INTERNAL' AND r.provider_session_no=1 AND public.oa_group_escalation_live(e.id,e.claim_id)",[delivery.id,ctx.actorId])).rows[0];
  if(!row||row.tenant_id!==ctx.tenantId||row.task_id!==delivery.task_id||row.run_id!==delivery.source_run_id||row.model_turns!==0||row.tool_calls!==0||row.persona_snapshot_id||row.persona_context_state!=='BUILTIN_ONLY'||row.task_status!=='COMPLETED'||row.cancel_requested_at||row.goal!=='明确确认的单事项同群升级'||canonical(row.budget)!==canonical({schemaVersion:1,maxTurns:0,maxTools:0,maxActiveMs:1}))return null;
  const target={kind:'GROUP',targetId:row.group_id,classificationCeiling:'INTERNAL'};
  if(canonical(delivery.target)!==canonical(target)||canonical(row.audience)!==canonical(target))return null;
  if(this.target&&(ctx.tenantId!==this.target.tenantId||ctx.actorId!==this.target.actorId||row.group_id!==this.target.groupId||row.id!==this.target.proposalId||row.preview_hash!==this.target.previewHash||row.contract_hash!==this.target.contractHash))return null;
  const proof=this.host.open(row),body=this.host.vault.open(JSON.parse(delivery.content_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:delivery:${delivery.id}`);
  if(body!==renderGroupEscalationNotification(proof.preview)||row.result!==body||delivery.args_hash!==hash(body))return null;
  const outbox=(await c.query("SELECT payload_ref FROM outbox WHERE kind='GROUP_ESCALATION' AND aggregate_id=$1 AND owner_id=$2 AND published_at IS NOT NULL",[row.id,ctx.actorId])).rows;
  if(outbox.length!==1||canonical(outbox[0]!.payload_ref)!==canonical({proposalId:row.id,claimId:row.claim_id,contentHash:hash(body)}))return null;
  return {row,proof,body};
 }
 async deliveryAllowed(c:pg.PoolClient,ctx:DbContext,delivery:Record<string,unknown>,signal?:AbortSignal){try{
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);bounded.throwIfAborted();
  const before=await this.local(c,ctx,delivery);if(!before||!await this.host.verifyPersisted(before.proof,bounded))return false;
  bounded.throwIfAborted();const after=await this.local(c,ctx,delivery);return !!after&&after.body===before.body&&after.row.preview_hash===before.row.preview_hash&&after.row.claim_id===before.row.claim_id;
 }catch{return false;}}
}
