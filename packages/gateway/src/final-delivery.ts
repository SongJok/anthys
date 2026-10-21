import {GROUP_CASE_READ_ID,GROUP_CASE_READ_VERSION,groupCaseReadBindingHash} from '../../groups/src/read-capability.js';
import {groupCaseReceiptDeliveryAllowed,groupCaseNarrativeAllowed} from '../../groups/src/receipts.js';
import {scheduleReceiptDeliveryAllowed} from '../../schedules/src/receipts.js';
import {reminderDeliveryAllowed} from '../../schedules/src/delivery.js';
import {memoryDeliveryAllowed} from '../../dingtalk/src/memories.js';
import {personaDeliveryAllowed} from '../../dingtalk/src/personas.js';
import {z} from 'zod';
import type pg from 'pg';
import {taskReceiptAllowed} from '../../dingtalk/src/task-receipt.js';
import type {DbContext} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {checkpointFactSchema} from '../../runtime/src/checkpoint.js';
import type {Lease} from '../../runtime/src/store.js';
import {parseFinalPlan} from '../../runtime/src/final-plan.js';
import {leaseSchema} from '../../runtime/src/lease-contract.js';
import {choiceStampSchema,selectionDependencies,loadChoice} from '../../runtime/src/source-choice.js';
import type {FinalEvidence} from './finalizer.js';
import {canonical} from './index.js';
import {clarificationDeliveryAllowed} from '../../dingtalk/src/clarification-receipt.js';
import {narrativeReceipt,needsNarrativeReview} from '../../runtime/src/narrative-review.js';
const proofSchema=z.object({version:z.literal(1),lease:leaseSchema,proposal:z.string(),evidence:z.array(z.object({fact:checkpointFactSchema,state:z.string(),choiceProjection:choiceStampSchema.optional()}).strict()),outputHash:z.string().regex(/^[a-f0-9]{64}$/),classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']).optional(),narrativeReviewId:z.uuid().optional(),sourceChoiceId:z.uuid().optional(),sourceSelectionIds:z.array(z.uuid()).optional()}).strict();
export type FinalSourceCheck=(ctx:DbContext,lease:Lease,c:pg.PoolClient,evidence:FinalEvidence[],signal?:AbortSignal)=>Promise<boolean>;
export async function finalDeliveryAllowed(c:pg.PoolClient,ctx:DbContext,vault:Vault,delivery:Record<string,unknown>,sources?:FinalSourceCheck):Promise<boolean>{
 try{
  if(!delivery.finalization_id)return delivery.control_kind==='GROUP_CASE'&&await groupCaseReceiptDeliveryAllowed(c,ctx,vault,delivery,sources)||delivery.control_kind==='SCHEDULE'&&await scheduleReceiptDeliveryAllowed(c,ctx,vault,delivery)||delivery.control_kind==='REMINDER'&&await reminderDeliveryAllowed(c,ctx,vault,delivery)||delivery.control_kind==='MEMORY'&&await memoryDeliveryAllowed(c,ctx,vault,delivery)||delivery.control_kind==='STOP'||delivery.control_kind==='PERSONA'&&await personaDeliveryAllowed(c,ctx,vault,delivery)||delivery.control_kind==='CLARIFICATION_REPLY'&&await clarificationDeliveryAllowed(c,ctx,vault,delivery)||await taskReceiptAllowed(c,ctx,vault,delivery);
  const row=(await c.query("SELECT * FROM run_finalizations WHERE id=$1 AND run_id=$2 AND owner_id=$3 AND session_no=$4 AND state IN ('VERIFIED','PARTIAL') AND expires_at>clock_timestamp()",[delivery.finalization_id,delivery.source_run_id,ctx.actorId,delivery.source_session_no])).rows[0];if(!row)return false;
  const proof=proofSchema.parse(JSON.parse(vault.open(row.plan_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:final:${row.id}`))),lease=proof.lease;
  if(proof.classification&&proof.classification!==delivery.classification)return false;
  const persona=(await c.query('SELECT persona_snapshot_id FROM runs WHERE id=$1',[lease.runId])).rows[0]?.persona_snapshot_id;if(!!persona!==!!lease.personaSnapshot||persona&&persona!==lease.personaSnapshot?.id)return false;
  if(lease.audience['kind']==='GROUP'&&!lease.groupAudience)return false;
  if(lease.audience['kind']==='GROUP'&&parseFinalPlan(proof.proposal).mode==='CLARIFICATION'&&!(await c.query("SELECT r.id FROM runs r WHERE r.id=$1 AND r.status='WAITING_USER' AND r.last_error='CLARIFICATION_REQUESTED' AND r.clarification_review_id=$2 AND NOT EXISTS(SELECT 1 FROM group_clarification_messages p WHERE p.run_id=r.id AND p.review_id=$2 AND p.state='PENDING')",[lease.runId,proof.narrativeReviewId??null])).rowCount)return false;
  if((parseFinalPlan(proof.proposal).mode==='SOURCE_CHOICE'||row.reason==='SOURCE_CHOICE_REQUIRED')!==!!proof.sourceChoiceId)return false;
  if(lease.runId!==delivery.source_run_id||lease.taskId!==delivery.task_id||lease.goal!==delivery.goal||lease.authEpoch!==Number(delivery.current_auth_epoch)||lease.policyVersion!==delivery.current_policy_version||canonical(lease.audience)!==canonical(delivery.audience)||hash(proof.proposal)!==row.source_hash||proof.outputHash!==row.output_hash)return false;
  const expiry=(await c.query('SELECT id FROM tasks WHERE id=$1 AND expires_at=$2::timestamptz',[lease.taskId,lease.expiresAt])).rowCount;if(!expiry)return false;
  const text=vault.open(JSON.parse(delivery.content_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:delivery:${delivery.id}`);if(hash(text)!==proof.outputHash)return false;
  if(needsNarrativeReview(proof.proposal,lease.goal)&&(!proof.narrativeReviewId||!await narrativeReceipt(c,ctx,lease,vault,proof.proposal,proof.narrativeReviewId)))return false;
  if(!await selectionDependencies(c,ctx,vault,lease,sources??(async()=>false),proof.sourceSelectionIds??[]))return false;
  if(proof.sourceChoiceId){const choice=await loadChoice(c,ctx,vault,proof.sourceChoiceId);if(!choice||choice.row.finalization_id!==row.id)return false;}
  if(proof.sourceChoiceId&&!(await c.query("SELECT r.id FROM runs r JOIN run_source_choices q ON q.tenant_id=r.tenant_id AND q.id=r.source_choice_id WHERE q.id=$1 AND q.answered_at IS NULL AND NOT EXISTS(SELECT 1 FROM source_choice_replies p WHERE p.choice_id=q.id AND p.state='PENDING')",[proof.sourceChoiceId])).rowCount)return false;
  if(lease.audience['kind']==='GROUP'||lease.personaSnapshot)return sources?await sources(ctx,lease,c,proof.evidence):false;
  return proof.evidence.length?sources?await sources(ctx,lease,c,proof.evidence):false:true;
 }catch{return false;}
}
export async function finalResultAllowed(c:pg.PoolClient,ctx:DbContext,vault:Vault,runId:string,result:string,sources:FinalSourceCheck):Promise<boolean>{
 try{
  const row=(await c.query("SELECT p.*,r.result_classification current_classification,t.id task_id,t.goal current_goal,t.audience,t.auth_epoch task_epoch,u.auth_epoch current_epoch,org.policy_version current_policy FROM run_finalizations p JOIN runs r ON r.tenant_id=p.tenant_id AND r.id=p.run_id AND r.owner_id=p.owner_id AND r.provider_session_no=p.session_no JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=r.owner_id JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN tenants org ON org.tenant_id=t.tenant_id WHERE r.id=$1 AND r.result=$2 AND r.status IN ('SUCCEEDED','PARTIAL','WAITING_USER') AND p.output_hash=$3 AND p.state IN ('VERIFIED','PARTIAL') AND p.expires_at>clock_timestamp() AND t.expires_at>clock_timestamp() AND t.status IN ('ACTIVE','COMPLETED') AND u.status='ACTIVE' AND org.status='ACTIVE' AND t.auth_epoch=u.auth_epoch ORDER BY p.created_at DESC,p.id DESC LIMIT 1",[runId,result,hash(result)])).rows[0];if(!row)return false;
  const proof=proofSchema.parse(JSON.parse(vault.open(row.plan_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:final:${row.id}`))),lease=proof.lease;
  if(proof.classification&&proof.classification!==row.current_classification)return false;
  const persona=(await c.query('SELECT persona_snapshot_id FROM runs WHERE id=$1',[lease.runId])).rows[0]?.persona_snapshot_id;if(!!persona!==!!lease.personaSnapshot||persona&&persona!==lease.personaSnapshot?.id)return false;
  if(lease.audience['kind']==='GROUP'&&!lease.groupAudience)return false;
  if(lease.audience['kind']==='GROUP'&&parseFinalPlan(proof.proposal).mode==='CLARIFICATION'&&!(await c.query("SELECT r.id FROM runs r WHERE r.id=$1 AND r.status='WAITING_USER' AND r.last_error='CLARIFICATION_REQUESTED' AND r.clarification_review_id=$2 AND NOT EXISTS(SELECT 1 FROM group_clarification_messages p WHERE p.run_id=r.id AND p.review_id=$2 AND p.state='PENDING')",[lease.runId,proof.narrativeReviewId??null])).rowCount)return false;
  if((parseFinalPlan(proof.proposal).mode==='SOURCE_CHOICE'||row.reason==='SOURCE_CHOICE_REQUIRED')!==!!proof.sourceChoiceId)return false;
  if(lease.runId!==runId||lease.taskId!==row.task_id||lease.goal!==row.current_goal||lease.authEpoch!==Number(row.current_epoch)||lease.policyVersion!==row.current_policy||canonical(lease.audience)!==canonical(row.audience)||hash(proof.proposal)!==row.source_hash||proof.outputHash!==row.output_hash)return false;
  if(!(await c.query('SELECT id FROM tasks WHERE id=$1 AND expires_at=$2::timestamptz',[lease.taskId,lease.expiresAt])).rowCount)return false;
  if(needsNarrativeReview(proof.proposal,lease.goal)&&(!proof.narrativeReviewId||!await narrativeReceipt(c,ctx,lease,vault,proof.proposal,proof.narrativeReviewId)))return false;
  if(!await selectionDependencies(c,ctx,vault,lease,sources,proof.sourceSelectionIds??[]))return false;
  if(proof.sourceChoiceId){const choice=await loadChoice(c,ctx,vault,proof.sourceChoiceId);if(!choice||choice.row.finalization_id!==row.id)return false;}
  if(proof.sourceChoiceId&&!(await c.query("SELECT r.id FROM runs r JOIN run_source_choices q ON q.tenant_id=r.tenant_id AND q.id=r.source_choice_id WHERE q.id=$1 AND q.answered_at IS NULL AND NOT EXISTS(SELECT 1 FROM source_choice_replies p WHERE p.choice_id=q.id AND p.state='PENDING')",[proof.sourceChoiceId])).rowCount)return false;
  return await sources(ctx,lease,c,proof.evidence);
 }catch{return false;}
}

// Called only after finalDeliveryAllowed; no separate source authorization is
// inferred from the mode. REPORT remains a safe group status until its resource
// audience is independently certified.
export async function groupNarrativeDelivery(c:pg.PoolClient,ctx:DbContext,vault:Vault,delivery:Record<string,unknown>):Promise<boolean>{try{if(!delivery.finalization_id)return delivery.control_kind==='GROUP_CASE'&&await groupCaseNarrativeAllowed(c,ctx,vault,delivery);const row=(await c.query('SELECT plan_ref FROM run_finalizations WHERE id=$1 AND run_id=$2 AND owner_id=$3',[delivery.finalization_id,delivery.source_run_id,ctx.actorId])).rows[0];if(!row)return false;const p=proofSchema.parse(JSON.parse(vault.open(row.plan_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:final:${delivery.finalization_id}`))),plan=parseFinalPlan(p.proposal);return p.lease.audience['kind']==='GROUP'&&!!p.lease.groupAudience&&(plan.claims.length===0&&['CONVERSATION','CLARIFICATION'].includes(plan.mode)||plan.mode==='REPORT'&&!plan.text&&p.evidence.length>0&&(p.evidence.every(e=>e.fact.capabilityId===GROUP_CASE_READ_ID&&e.fact.version===GROUP_CASE_READ_VERSION&&e.fact.bindingHash===groupCaseReadBindingHash&&e.fact.risk==='READ')||p.evidence.every(e=>e.fact.capabilityId==='company.agent.ask'&&e.fact.version==='1.0.0'&&e.fact.risk==='READ'&&e.fact.result.verification?.state==='UNVERIFIED'&&e.fact.result.completeness==='UNKNOWN')));}catch{return false;}}
