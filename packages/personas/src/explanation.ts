import type {DbContext} from '../../storage/src/database.js';
import type {RuntimeStore,Lease} from '../../runtime/src/store.js';
import {runtimeBudgetSchema} from '../../runtime/src/budget.js';
import {personaContextExplanationSchema,type PersonaContextExplanation} from './explanation-schema.js';

export async function describePersonaContext(store:RuntimeStore,ctx:DbContext,runId:string):Promise<PersonaContextExplanation|null>{
 return store.db.scope(ctx,async c=>{
  const row=(await c.query(`SELECT r.id,r.task_id,r.fence,r.lease_owner,r.active_ms,r.budget,r.persona_context_state,r.persona_snapshot_id,
   p.id snapshot_id,p.proof_hash snapshot_hash,g.id group_id,g.proof_hash group_hash,t.goal,t.audience,t.auth_epoch,org.policy_version,
   to_char(t.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') expires_text,
   (u.status='ACTIVE' AND org.status='ACTIVE' AND t.auth_epoch=u.auth_epoch AND t.expires_at>clock_timestamp()
    AND t.cancel_requested_at IS NULL AND t.status IN ('OPEN','ACTIVE','COMPLETED') AND NOT public.oa_run_content_erased(r.id)) context_current
   FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.requester_id=r.owner_id
   JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.owner_id JOIN tenants org ON org.tenant_id=r.tenant_id
   LEFT JOIN run_persona_snapshots p ON p.tenant_id=r.tenant_id AND p.id=r.persona_snapshot_id AND p.run_id=r.id AND p.owner_id=r.owner_id
   LEFT JOIN run_group_audiences g ON g.tenant_id=r.tenant_id AND g.id=r.group_audience_id AND g.run_id=r.id AND g.owner_id=r.owner_id
   WHERE r.id=$1 AND r.owner_id=$2`,[runId,ctx.actorId])).rows[0];
  if(!row)return null;
  const unavailable:PersonaContextExplanation={state:'UNAVAILABLE'};
  if(row.context_current!==true)return unavailable;
  if(['UNBOUND','BUILTIN_ONLY','LEGACY_NONE'].includes(row.persona_context_state as string)){
   if(row.persona_snapshot_id)return unavailable;
   return personaContextExplanationSchema.parse({state:row.persona_context_state});
  }
  if(row.persona_context_state!=='BOUND'||!store.personae||!row.snapshot_id||!row.snapshot_hash)return unavailable;
  const budget=runtimeBudgetSchema.safeParse(row.budget),fence=Number(row.fence);
  if(!budget.success||!Number.isSafeInteger(fence)||fence<1)return unavailable;
  const lease:Lease={...budget.data,budget:budget.data,runId,taskId:row.task_id as string,fence,workerId:String(row.lease_owner??''),goal:row.goal as string,
   authEpoch:Number(row.auth_epoch),policyVersion:row.policy_version as string,expiresAt:row.expires_text as string,
   remainingActiveMs:Math.max(1,Math.floor(budget.data.maxActiveMs-Number(row.active_ms))),audience:row.audience as Record<string,unknown>,
   personaSnapshot:{id:row.snapshot_id as string,hash:row.snapshot_hash as string},
   ...(row.group_id?{groupAudience:{id:row.group_id as string,hash:row.group_hash as string}}:{})};
  // Reuse model/final-delivery proof, source, erasure and audience checks.
  const proof=await store.personae.current(c,ctx,lease,(...args)=>store.groupAudienceAllowed(...args));
  if(!proof)return unavailable;
  return personaContextExplanationSchema.parse({state:'BOUND',checkedAt:new Date().toISOString(),snapshotId:row.snapshot_id,
   policyVersion:proof.policyVersionNo,templateVersion:proof.templateVersion,sources:proof.sources.map(s=>({kind:s.scope.kind,version:s.version}))});
 });
}
